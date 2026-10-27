'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');

const marker = 'incomplete response returned, reason: max_output_tokens';
const capCode = 'PROVIDER_OUTPUT_LIMIT';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate) {
    const until = Date.now() + 5000;
    while (!predicate()) { assert(Date.now() < until, 'owned fake request reached its expected state'); await new Promise(resolve => setImmediate(resolve)); }
}

// This replaces every child process, including status probes. It never opens
// a real executable, connects to a service or processes media.
function fakeSpawn(handler) {
    const calls = [];
    let active = 0, peak = 0;
    const spawnImpl = (binary, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const cancellation = deferred(), input = [];
        const call = { child, args, binary, killed: false, cancelled: cancellation.promise };
        let closed = false;
        calls.push(call);
        if (args[0] === 'exec') { active++; peak = Math.max(peak, active); }
        const close = exit => {
            if (closed) return;
            if (call.closeGate) { const gate = call.closeGate; gate.promise.then(() => { call.closeGate = null; close(exit); }); return; }
            closed = true;
            if (args[0] === 'exec') active--;
            child.emit('close', exit);
        };
        child.kill = () => { call.killed = true; cancellation.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', bytes => input.push(bytes));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = Buffer.concat(input).toString('utf8');
                if (args.includes('login')) child.stderr.write('Logged in using ChatGPT\n');
                else if (args.includes('import faster_whisper; print("ready")')) child.stdout.write('ready\n');
                else {
                    assert.equal(args[0], 'exec', 'no ASR, ffmpeg or other process is requested');
                    call.schema = JSON.parse(await fs.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
                    call.kind = call.schema.properties.plot ? 'summary' : call.schema.properties.events ? 'chunk' : 'translation';
                    const delimiter = '자료 JSON:\n';
                    call.payload = JSON.parse(call.input.slice(call.input.indexOf(delimiter) + delimiter.length));
                    if (call.kind === 'chunk') call.index = Number(/구간 (\d+)\/\d+입니다/.exec(call.input)[1]);
                    const answer = await handler(call);
                    if (!call.killed && answer !== undefined) await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(answer));
                }
                if (!call.killed) close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    return { calls, spawnImpl, get active() { return active; }, get peak() { return peak; } };
}

const finalSummary = () => ({ summary: '합성 요약입니다.', plot: '합성 사건의 순서입니다.', dialogueSummary: '합성 대화의 주제입니다.', labels: ['합성'], frames: [], limitations: [] });
const chunkSummary = () => ({ summary: '합성 구간 요약', dialogue: '합성 구간 주제', events: ['합성 구간 사건'] });
const translated = call => ({ subtitles: call.payload.subtitles.map(cue => ({ index: cue.index,
    text: '역에서 만날 예정입니다. '.repeat(Math.max(1, Math.ceil(cue.text.length / 12))).trim() })), terms: [] });
function fail(call, extra = {}) { call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: marker, ...extra } }) + '\n'); }

async function fixture(t, { count = 1, sourceText = '駅で会う予定です。', handler, overrides = {}, signal } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-output-cap-v1932-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: index, start: 1 + index * 3, end: 3 + index * 3, text: sourceText }));
    const record = { id: 'owned-cap', name: 'owned-synthetic.mp4', duration: 4 + count * 3, hasAudio: false, frames: [], warnings: [],
        status: 'completed', transcriptSource: 'sidecar:owned.srt', transcriptLanguage: 'ja', transcript,
        summary: '이전 합성 요약', plot: '이전 합성 줄거리', dialogueSummary: '이전 합성 대화', labels: ['기존'], ...overrides };
    const original = structuredClone(transcript), events = [];
    const mocked = fakeSpawn(handler || (call => call.kind === 'summary' ? finalSummary() : call.kind === 'chunk' ? chunkSummary() : translated(call)));
    const provider = createNoKeyProvider({ spawnImpl: mocked.spawnImpl, platform: 'win32',
        environment: { VIDEORANDOM_CODEX: 'owned-mock-codex', VIDEORANDOM_PYTHON: 'owned-mock-python' },
        capacityWait: () => { throw new Error('output limits never authorize capacity retries'); } });
    const run = () => provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'fast', signal,
        onDiagnostic: event => events.push(event) });
    const drained = async () => {
        assert.equal(mocked.active, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), [], 'all owned temporary requests are removed');
    };
    return { dataDir, record, original, mocked, provider, run, events, drained };
}

test('final summary output cap is not retried and preserves the old summary while translating all original cues', async t => {
    const f = await fixture(t, { count: 3, handler: call => {
        if (call.kind === 'summary') { fail(call); return; }
        return translated(call);
    } });
    const result = await f.run();
    assert.equal(result.status, 'partial');
    assert.equal(result.analysisDiagnostic.code, capCode);
    assert.equal(result.analysisDiagnostic.stage, 'summary');
    assert.equal(result.analysisDiagnostic.providerErrorType, 'output-limit');
    assert.equal(result.summary, '이전 합성 요약');
    assert.equal(result.plot, '이전 합성 줄거리');
    assert.equal(result.dialogueSummary, '이전 합성 대화');
    assert.deepEqual(result.transcript, f.original);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'summary').length, 1);
    const requests = f.mocked.calls.filter(call => call.kind === 'translation');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].payload.subtitles.map(cue => cue.text), f.original.map(cue => cue.text));
    assert.equal(result.subtitleTranslation.length, f.original.length);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleError, null);
    assert.doesNotMatch(result.error, /max_output_tokens/);
    await f.drained();
});

test('a long-transcript capped chunk drains both started children before translating untouched source', async t => {
    const firstGate = deferred(), closeGate = deferred();
    let f;
    f = await fixture(t, { count: 65, sourceText: '駅で会う予定です。'.repeat(80), handler: async call => {
        if (call.kind === 'chunk') {
            if (call.index === 1) { await firstGate.promise; fail(call); }
            else { call.closeGate = closeGate; await call.cancelled; }
            return;
        }
        assert.notEqual(call.kind, 'summary', 'no final summary is launched after a failed chunk');
        return translated(call);
    } });
    const pending = f.run();
    await waitFor(() => f.mocked.calls.filter(call => call.kind === 'chunk').length === 2);
    firstGate.resolve();
    await waitFor(() => f.mocked.calls.some(call => call.index === 2 && call.killed));
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 0, 'translation waits for every started chunk to close');
    closeGate.resolve();
    const result = await pending;
    assert.equal(result.analysisDiagnostic.code, capCode);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'chunk').length, 2);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'summary').length, 0);
    assert.equal(f.mocked.peak, 2);
    assert.deepEqual(result.transcript, f.original);
    const source = f.mocked.calls.filter(call => call.kind === 'translation').flatMap(call => call.payload.subtitles).map(cue => cue.text);
    assert.deepEqual(source, f.original.map(cue => cue.text));
    assert.equal(result.subtitleTranslation.length, f.original.length);
    assert.equal(result.status, 'partial');
    await f.drained();
});

for (const [label, message, extra, expected] of [
    ['503', marker, { status: 503 }, 'PROVIDER_UNAVAILABLE'],
    ['authentication', marker, { status_code: 401 }, 'PROVIDER_AUTH'],
    ['quota', marker, { status: 429 }, 'PROVIDER_QUOTA'],
    ['refusal', 'Request refused', {}, 'PROVIDER_REFUSAL']
]) test(`summary cap cannot mask ${label} or authorize translation`, async t => {
    const f = await fixture(t, { handler: call => {
        call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message, ...extra } }) + '\n');
    } });
    const result = await f.run();
    assert.equal(result.subtitleDiagnostic.code, expected);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'summary').length, 1);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 0);
    assert.deepEqual(result.transcript, f.original);
    await f.drained();
});

test('parent cancellation during a capped summary remains cancelled and never starts translation', async t => {
    const controller = new AbortController();
    const f = await fixture(t, { signal: controller.signal, handler: call => { fail(call); controller.abort(); } });
    await assert.rejects(f.run(), error => error.name === 'AbortError');
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 0);
    assert.deepEqual(f.record.transcript, f.original);
    await f.drained();
});

test('translation output cap retains a checked prefix with fixed diagnostics and never repeats the failed request', async t => {
    const f = await fixture(t, { count: 81, handler: call => {
        if (call.kind === 'summary') return finalSummary();
        if (call.payload.subtitles[0].index === 80) { fail(call); return; }
        return translated(call);
    } });
    const result = await f.run();
    assert.equal(result.subtitleDiagnostic.code, capCode);
    assert.equal(result.subtitleDiagnostic.providerErrorType, 'output-limit');
    assert.equal(result.subtitleDiagnostic.stage, 'translation_draft');
    assert.equal(result.subtitleTranslationPartial.length, 80);
    assert.equal(result.subtitleTranslationProgress.completedCues, 80);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 2);
    assert.deepEqual(result.transcript, f.original);
    assert.doesNotMatch(result.subtitleError, /max_output_tokens|Codex 요약 실패/);
    await f.drained();
});

test('a failed translation-only cap preserves a longer previously checked partial', async t => {
    const f = await fixture(t, { count: 2, handler: call => { fail(call); } });
    const saved = [{ ...f.original[0], text: '역에서 만날 예정입니다.' }];
    f.record.subtitleTranslationPartial = structuredClone(saved);
    f.record.subtitleTranslationProgress = { version: 1, sourceFingerprint: crypto.createHash('sha256')
        .update(JSON.stringify(f.original.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex'),
        language: 'ko', complete: false, sourceComplete: true, translationComplete: false, totalCues: 2, completedCues: 1 };
    const result = await f.provider.translateKoreanOnly(f.record, { dataDir: f.dataDir, subtitleQuality: 'fast' });
    assert.equal(result.subtitleDiagnostic.code, capCode);
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.deepEqual(result.subtitleTranslationPartial, saved);
    assert.deepEqual(result.transcript, f.original);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 1);
    await f.drained();
});

test('a successful JSON response envelope cannot grant the private execution-cap continuation', async t => {
    const f = await fixture(t, { handler: () => ({ code: capCode, providerErrorType: 'output-limit', executionSource: 'provider-error', message: marker }) });
    const result = await f.run();
    assert.equal(f.mocked.calls.filter(call => call.kind === 'summary').length, 1);
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 0);
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNKNOWN');
    assert.deepEqual(result.transcript, f.original);
    await f.drained();
});

for (const capIndex of [1, 2]) test(`a started chunk reporting a real 503 while cap chunk ${capIndex} cancellation drains keeps the shared failure`, async t => {
    const failFirst = deferred();
    const f = await fixture(t, { count: 65, sourceText: '駅で会う予定です。'.repeat(80), handler: async call => {
        if (call.kind !== 'chunk') return translated(call);
        if (call.index === capIndex) { await failFirst.promise; fail(call); return; }
        const closeGate = deferred(); call.closeGate = closeGate;
        await call.cancelled;
        call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'HTTP status 503 Service Unavailable', status: 503 } }) + '\n');
        closeGate.resolve();
    } });
    const pending = f.run();
    await waitFor(() => f.mocked.calls.filter(call => call.kind === 'chunk').length === 2);
    failFirst.resolve();
    const result = await pending;
    assert.equal(f.mocked.calls.filter(call => call.kind === 'translation').length, 0, 'the actual shared failure cannot be hidden by the earlier cap');
    assert.equal(result.subtitleDiagnostic.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(f.mocked.calls.filter(call => call.kind === 'chunk').length, 2);
    assert.deepEqual(result.transcript, f.original);
    await f.drained();
});
