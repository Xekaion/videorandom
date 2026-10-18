const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, getEventListeners } = require('events');
const { PassThrough } = require('stream');
const { createNoKeyProvider } = require('../lib/no-key-provider');

const finalSummary = { summary: '합성 요약', plot: '합성 사건 순서', dialogueSummary: '합성 대화', labels: ['합성'], frames: [], limitations: [] };
const chunkAnswer = index => ({ summary: `합성 요약 ${index}`, dialogue: `합성 대화 ${index}`, events: [`합성 사건 ${index}`] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'owned mock request reached its expected state');
        await new Promise(resolve => setImmediate(resolve));
    }
}

function syntheticSpawn(handler, { throwBeforeSpawn } = {}) {
    const calls = [];
    let active = 0, peak = 0;
    const spawnImpl = (binary, args) => {
        if (args[0] === 'exec' && throwBeforeSpawn) throwBeforeSpawn();
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const chunks = [], cancelled = deferred();
        const call = { child, args, input: '', killed: false, cancelled: cancelled.promise };
        calls.push(call);
        let closed = false;
        if (args[0] === 'exec') { active++; peak = Math.max(peak, active); }
        const close = code => {
            if (closed) return;
            if (call.closeGate) { call.closeGate.promise.then(() => { call.closeGate = null; close(code); }); return; }
            closed = true;
            if (args[0] === 'exec') active--;
            child.emit('close', code);
        };
        child.kill = () => {
            call.killed = true;
            cancelled.resolve();
            queueMicrotask(() => close(null));
        };
        child.stdin.on('data', bytes => chunks.push(bytes));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            call.input = Buffer.concat(chunks).toString('utf8');
            try {
                if (args.includes('login')) child.stderr.write('Logged in using ChatGPT\n');
                else if (args.includes('import faster_whisper; print("ready")')) child.stdout.write('ready\n');
                else {
                    call.schema = JSON.parse(await fs.promises.readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
                    call.final = Boolean(call.schema.properties.plot);
                    call.payload = JSON.parse(call.input.slice(call.input.indexOf('자료 JSON:\n') + '자료 JSON:\n'.length));
                    if (!call.final) {
                        const [, index, count] = /구간 (\d+)\/(\d+)입니다/.exec(call.input);
                        call.index = Number(index); call.count = Number(count);
                    }
                    const result = await handler(call);
                    if (!closed) await fs.promises.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result), 'utf8');
                }
                if (!closed) close(0);
            } catch (error) {
                if (!closed) { child.stderr.write(error.message); close(error.exitCode || 1); }
            }
        }));
        return child;
    };
    return { spawnImpl, calls, get active() { return active; }, get peak() { return peak; } };
}

async function fixture(t, { sourceLength = 78000, spawnOptions, handler, signal, onProgress } = {}) {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-summary-concurrency-'));
    t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
    const original = Array.from({ length: Math.ceil(sourceLength / 1000) }, (_, index) => `[합성 구간 ${index}]` + '가'.repeat(1000)).join('').slice(0, sourceLength);
    const record = { id: 'synthetic-summary', name: 'synthetic.mp4', duration: 500, hasAudio: false, frames: [], warnings: [],
        transcriptSource: 'synthetic', transcript: [{ start: 1, end: 499, text: original }] };
    const mocked = syntheticSpawn(handler || (call => call.final ? finalSummary : chunkAnswer(call.index)), spawnOptions);
    const provider = createNoKeyProvider({ spawnImpl: mocked.spawnImpl,
        environment: { VIDEORANDOM_CODEX: 'owned-mock-codex', VIDEORANDOM_PYTHON: 'owned-mock-python' }, platform: 'win32' });
    const run = () => provider.analyzeExtracted(record, { dataDir, signal, onProgress });
    const assertDrained = async () => {
        assert.equal(mocked.active, 0, 'all started mock children close before analysis returns');
        assert.deepEqual(await fs.promises.readdir(path.join(dataDir, 'tmp')).catch(() => []), [], 'all per-call schema/output directories are removed');
    };
    return { dataDir, record, original, mocked, run, assertDrained };
}

test('summary overlaps only two independent chunks, retains all source and joins reverse completions in source order', async t => {
    const gates = new Map(), completed = [], progress = [];
    const controller = new AbortController();
    const f = await fixture(t, { signal: controller.signal, onProgress: (stage, percent) => { if (stage === 'summary') progress.push(percent); },
        handler: async call => {
            if (call.final) return finalSummary;
            const gate = deferred(); gates.set(call.index, gate);
            await Promise.race([gate.promise, call.cancelled]);
            completed.push(call.index);
            return chunkAnswer(call.index);
        } });
    const pending = f.run();
    await waitFor(() => gates.has(1) && gates.has(2));
    assert.equal(gates.size, 2);
    gates.get(2).resolve();
    await waitFor(() => gates.has(3));
    gates.get(1).resolve();
    await waitFor(() => gates.has(4));
    gates.get(4).resolve();
    await waitFor(() => gates.has(5));
    gates.get(3).resolve();
    await waitFor(() => gates.has(6));
    gates.get(6).resolve(); gates.get(5).resolve();
    const result = await pending;
    assert.equal(result.error, null); assert.equal(result.transcript[0].text, f.original);
    assert.equal(f.mocked.peak, 2); assert.equal(completed[0], 2);
    const chunks = f.mocked.calls.filter(call => call.index).sort((a, b) => a.index - b.index);
    assert.equal(chunks.map(call => call.payload.transcript).join(''), '[00:00:01–00:08:19] ' + f.original);
    const final = f.mocked.calls.find(call => call.final);
    assert.match(final.payload.transcript, /구간 1: 합성 요약 1[\s\S]*구간 2: 합성 요약 2[\s\S]*구간 6: 합성 요약 6/);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await f.assertDrained();
});

test('a failed chunk cancels its sibling, retains the first error and never starts queued chunks or final summary', async t => {
    const bothStarted = deferred(), failNow = deferred();
    let started = 0;
    const f = await fixture(t, { handler: async call => {
        if (++started === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (call.index === 1) { await failNow.promise; throw Object.assign(new Error('owned summary service unavailable'), { exitCode: 1 }); }
        await call.cancelled;
        throw new Error('owned cancelled sibling must not replace original error');
    } });
    const pending = f.run(); await bothStarted.promise; failNow.resolve();
    const result = await pending;
    assert.match(result.error, /owned summary service unavailable/);
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    assert.equal(f.mocked.calls.some(call => call.final), false);
    assert.equal(f.mocked.calls.find(call => call.index === 2).killed, true);
    await f.assertDrained();
});

test('a malformed chunk cancels its sibling without consuming a later chunk', async t => {
    const ready = deferred(); let started = 0;
    const f = await fixture(t, { handler: async call => {
        if (++started === 2) ready.resolve();
        await ready.promise;
        if (call.index === 1) return { summary: '합성', dialogue: '합성', events: [42] };
        await call.cancelled; return chunkAnswer(call.index);
    } });
    const result = await f.run();
    assert.equal(result.error, 'Codex 구간 요약 형식이 올바르지 않습니다.');
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    await f.assertDrained();
});

test('service failure stops queued work before gated temporary cleanup finishes', async t => {
    const ready = deferred(), rmEntered = deferred(), rmGate = deferred(), siblingSuccess = deferred();
    const originalRm = fs.promises.rm;
    let started = 0, failedDirectory, returned = false;
    const f = await fixture(t, { handler: async call => {
        if (++started === 2) ready.resolve();
        await ready.promise;
        if (call.index === 1) {
            failedDirectory = path.dirname(call.args[call.args.indexOf('--output-last-message') + 1]);
            throw new Error('owned service failure before cleanup');
        }
        await siblingSuccess.promise;
        return chunkAnswer(call.index);
    } });
    fs.promises.rm = async (target, options) => {
        if (target === failedDirectory) { rmEntered.resolve(); await rmGate.promise; }
        return originalRm.call(fs.promises, target, options);
    };
    try {
        const pending = f.run().finally(() => { returned = true; });
        await rmEntered.promise;
        siblingSuccess.resolve();
        for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
        assert.equal(returned, false, 'analysis waits for failed-child temporary cleanup');
        rmGate.resolve();
        assert.match((await pending).error, /owned service failure before cleanup/);
        await f.assertDrained();
    } finally { rmGate.resolve(); siblingSuccess.resolve(); fs.promises.rm = originalRm; }
});

test('streaming 503 stops queued work before the failed child emits its delayed close', async t => {
    const ready = deferred(), closeGate = deferred(), emittedFailure = deferred(), siblingSuccess = deferred();
    let started = 0, returned = false;
    const f = await fixture(t, { handler: async call => {
        if (++started === 2) ready.resolve();
        await ready.promise;
        if (call.index === 1) {
            call.closeGate = closeGate;
            call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: '503 Service Unavailable owned stream' } }) + '\n');
            emittedFailure.resolve();
            await closeGate.promise;
        } else await siblingSuccess.promise;
        return chunkAnswer(call.index);
    } });
    const pending = f.run().finally(() => { returned = true; });
    await emittedFailure.promise; siblingSuccess.resolve();
    for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    assert.equal(returned, false, 'analysis drains the failed child before returning');
    closeGate.resolve();
    assert.match((await pending).error, /503 Service Unavailable owned stream/);
    await f.assertDrained();
});

test('parent cancellation drains both active chunks and removes every parent abort listener', async t => {
    const controller = new AbortController(); const ready = deferred(); let started = 0;
    const initialListeners = getEventListeners(controller.signal, 'abort').length;
    const f = await fixture(t, { signal: controller.signal, handler: async call => {
        if (++started === 2) ready.resolve();
        await call.cancelled; return chunkAnswer(call.index);
    } });
    const pending = f.run(); await ready.promise; controller.abort();
    await assert.rejects(pending, { name: 'AbortError', message: '분석이 중지되었습니다.' });
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, initialListeners);
    await f.assertDrained();
});

test('a synchronous child spawn failure preserves its error and cleans pending sibling preparation', async t => {
    let attempts = 0;
    const f = await fixture(t, { spawnOptions: { throwBeforeSpawn() {
        attempts++;
        if (attempts === 1) throw new Error('owned synchronous summary spawn failure 1');
    } }, handler: async call => { await call.cancelled; return chunkAnswer(call.index); } });
    const result = await f.run();
    assert.match(result.error, /owned synchronous summary spawn failure 1$/);
    assert.ok(attempts >= 1 && attempts <= 2, 'only the already preparing worker pair can reach spawn');
    await f.assertDrained();
});

test('a natural child failure racing parent abort preserves the first observed service error', async t => {
    const controller = new AbortController(), ready = deferred(); let started = 0;
    const f = await fixture(t, { signal: controller.signal, handler: async call => {
        if (++started === 2) ready.resolve();
        await ready.promise;
        if (call.index === 1) {
            throw new Error('owned first service failure');
        }
        // The pool cancels this child only after recording the service failure.
        // Race parent abort with its close and temporary-directory removal.
        await call.cancelled; controller.abort(); return chunkAnswer(call.index);
    } });
    let result;
    try { result = await f.run(); }
    catch (error) { result = error.record; }
    assert.match(result.error, /owned first service failure/);
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 2);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await f.assertDrained();
});

test('short sources use the same single final-summary call without creating a chunk pool', async t => {
    const controller = new AbortController();
    const f = await fixture(t, { sourceLength: 1000, signal: controller.signal });
    const result = await f.run();
    assert.equal(result.error, null);
    assert.equal(f.mocked.calls.filter(call => call.args[0] === 'exec').length, 1);
    assert.equal(f.mocked.peak, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await f.assertDrained();
});

test('chunk pools complete each depth before ordered regrouping creates the next depth', async t => {
    let firstDepth = 0, laterDepth = 0;
    const f = await fixture(t, { handler: async call => {
        if (call.final) return finalSummary;
        if (call.payload.transcript.includes('합성 구간')) {
            firstDepth++;
            return { summary: `긴 합성 요약 ${call.index} ` + '나'.repeat(5000), dialogue: '합성 대화', events: [] };
        }
        assert.equal(firstDepth, 6, 'all original chunks finish before any recursive chunk starts');
        laterDepth++;
        return chunkAnswer(call.index);
    } });
    const result = await f.run();
    assert.equal(result.error, null); assert.equal(firstDepth, 6); assert.ok(laterDepth >= 2);
    assert.ok(f.mocked.peak <= 2);
    await f.assertDrained();
});

test('fixed-delay synthetic summary benchmark removes one serial request wave per pair', async t => {
    const delay = 80;
    let serialElapsed;
    const serialStart = performance.now();
    for (let index = 0; index < 6; index++) await new Promise(resolve => setTimeout(resolve, delay));
    serialElapsed = performance.now() - serialStart;
    const f = await fixture(t, { handler: async call => {
        if (call.final) return finalSummary;
        await Promise.race([new Promise(resolve => setTimeout(resolve, delay)), call.cancelled]);
        return chunkAnswer(call.index);
    } });
    const started = performance.now(); const result = await f.run(); const pooledElapsed = performance.now() - started;
    assert.equal(result.error, null); assert.equal(f.mocked.calls.filter(call => call.index).length, 6);
    assert.equal(f.mocked.peak, 2);
    t.diagnostic(`Owned synthetic chunk stage only: 6 × ${delay} ms; serial ${serialElapsed.toFixed(1)} ms, two-worker analysis ${pooledElapsed.toFixed(1)} ms. This is not an actual AI or full-video speed measurement.`);
    await f.assertDrained();
});
