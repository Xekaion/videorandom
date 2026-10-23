const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { codexModelPolicy, codexModelArguments, sanitizeCodexModels } = require('../lib/codex-model-policy');
const { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics } = require('../lib/provider-execution-diagnostics');
const { createProviderCapacityRecovery, isProviderCapacityError } = require('../lib/provider-capacity-recovery');
const { classifyDiagnosticError } = require('../lib/diagnostics');
const { createNoKeyProvider } = require('../lib/no-key-provider');
const { catalogRecord } = require('../lib/catalog-record');
const { classifyQueueRecord } = require('../lib/queue-outcome');

const policy = { requestedModel: 'gpt-6-luna', reasoningEffort: 'low', serviceTier: 'standard' };
const capacity = extra => Object.assign(new Error('Codex 요약 실패: Selected model is at capacity. Please try a different model.'), {
    code: 'PROVIDER_CAPACITY', executionSource: 'provider-error', providerErrorType: 'capacity', ...extra
});

test('the application explicitly selects the cheapest documented model with low reasoning and the default tier', () => {
    assert.deepEqual(codexModelPolicy(), policy);
    assert(Object.isFrozen(codexModelPolicy()));
    assert.deepEqual(codexModelArguments(policy), ['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"',
        '-c', 'service_tier="default"', '--disable', 'fast_mode']);
    assert.deepEqual(codexModelPolicy({ VIDEORANDOM_CODEX_MODEL: 'gpt-5.6-luna' }), { ...policy, requestedModel: 'gpt-5.6-luna' });
});
for (const value of [' ', 'gpt-6-luna\nSECRET', 'https://private-model', 'gpt-test/model', '--model secret']) {
    test(`invalid model override cannot enter CLI arguments or diagnostics: ${JSON.stringify(value)}`, () => {
        assert.throws(() => codexModelPolicy({ VIDEORANDOM_CODEX_MODEL: value }), TypeError);
        assert.equal(sanitizeCodexModels({ translation: { ...policy, requestedModel: value } }), undefined);
    });
}
test('only requested model settings survive transport metadata sanitization and compact result projection', () => {
    const codexModels = { translation: { ...policy, actualModel: 'UNVERIFIED', apiKey: 'PRIVATE' }, bogus: policy };
    assert.deepEqual(sanitizeCodexModels(codexModels), { translation: policy });
    const compact = catalogRecord({ id: 'owned', status: 'partial', frames: [], transcript: [], codexModels });
    assert.deepEqual(compact.codexModels, { translation: policy });
    assert(!JSON.stringify(compact).includes('PRIVATE')); assert(!JSON.stringify(compact).includes('UNVERIFIED'));
    const safe = sanitizeProviderExecutionDiagnostics({ providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low',
        providerServiceTier: 'standard', providerActualModel: 'UNVERIFIED', prompt: 'PRIVATE' });
    assert.deepEqual(safe, { providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard' });
});

for (const channel of ['event', 'stderr', 'machine']) test(`trusted ${channel} capacity evidence is classified precisely`, () => {
    const d = createProviderExecutionDiagnostics();
    if (channel === 'event') d.observeEvent({ type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } });
    if (channel === 'stderr') { d.observeStderr('Selected model is at '); d.observeStderr('capacity. Please try a different model.\n'); }
    if (channel === 'machine') d.observeEvent({ type: 'error', error: { code: 'server_is_overloaded', status: 503,
        headers: { 'retry-after': '120' }, message: 'Unavailable' } });
    const info = d.snapshot({ executionSource: 'provider-error' });
    assert.equal(info.providerErrorType, 'capacity');
    assert.equal(classifyDiagnosticError(Object.assign(new Error('Codex 요약 실패'), info)).code, 'PROVIDER_CAPACITY');
    if (channel === 'machine') assert.equal(info.providerRetryAfterMs, 120000);
});
for (const blocker of [
    ['authentication', 'HTTP status 401', 'PROVIDER_AUTH'], ['quota', 'HTTP status 429', 'PROVIDER_QUOTA'],
    ['refusal', 'Request refused', 'PROVIDER_REFUSAL'], ['timeout', 'Request timed out', 'PROVIDER_TIMEOUT'],
    ['network', 'ECONNRESET', 'NETWORK_UNREACHABLE']
]) for (const order of ['before', 'after']) test(`${blocker[0]} ${order} capacity cannot acquire retry eligibility`, () => {
    const d = createProviderExecutionDiagnostics();
    if (order === 'before') d.observeStderr(blocker[1] + '\n');
    d.observeEvent({ type: 'error', error: { message: 'Selected model is at capacity.' } });
    if (order === 'after') d.observeStderr(blocker[1] + '\n');
    const info = d.snapshot({ executionSource: 'provider-error' });
    assert.equal(info.providerErrorType, blocker[0]);
    assert.equal(classifyDiagnosticError(Object.assign(new Error('Codex 요약 실패: Selected model is at capacity.'), info)).code, blocker[2]);
    assert.equal(isProviderCapacityError(capacity(info)), false);
});
for (const text of ['Prompt: Selected model is at capacity.', '{"text":"Selected model is at capacity."}',
    'Selected model is at capacity-check.', 'The dialogue says Selected model is at capacity.']) {
    test(`untrusted output text is not capacity evidence: ${text}`, () => {
        const d = createProviderExecutionDiagnostics(); d.observeStderr(text + '\n');
        d.observeEvent({ type: 'item.completed', item: { text: 'Selected model is at capacity.' } });
        assert.equal(d.snapshot().providerErrorType, undefined);
    });
}

function recoveryFixture(options = {}) {
    let time = 1000;
    const waits = [];
    const recovery = createProviderCapacityRecovery({ now: () => time, random: () => 0,
        wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; }, ...options });
    return { recovery, waits };
}
test('exact capacity waits 30 then 60 seconds and succeeds without changing the operation', async () => {
    const f = recoveryFixture(); let calls = 0;
    const result = await f.recovery.run(async () => { if (++calls < 3) throw capacity(); return 'owned success'; });
    assert.equal(result, 'owned success'); assert.equal(calls, 3); assert.deepEqual(f.waits, [30000, 60000]);
});
test('persistent capacity stops after the bounded request budget and preserves the original error', async () => {
    const f = recoveryFixture(); const error = capacity(); let calls = 0;
    await assert.rejects(f.recovery.run(async () => { calls++; throw error; }), e => e === error && e.providerCapacityExhausted === true);
    assert.equal(calls, 3); assert.deepEqual(f.waits, [30000, 60000]);
});
test('parallel requests reserve one shared job retry budget before waiting', async () => {
    const f = recoveryFixture(); let calls = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => f.recovery.run(async () => { calls++; throw capacity(); })));
    assert(outcomes.every(value => value.status === 'rejected'));
    assert.equal(f.recovery.snapshot().retriesUsed, 4); assert.equal(f.waits.length, 4); assert.equal(calls, 10);
});
for (const extra of [{ code: 'PROVIDER_AUTH' }, { providerErrorType: 'quota' }, { executionSource: 'local-deadline' },
    { httpStatus: 403 }, { providerHttpStatus: 429 }, { refusalSource: 'execution-error' }, { systemCode: 'ECONNRESET' },
    { causeCode: 'PROVIDER_QUOTA' }, { name: 'AbortError' }, { code: 'PROVIDER_UNAVAILABLE', providerHttpStatus: 503 }]) {
    test(`other failures are never replayed: ${JSON.stringify(extra)}`, async () => {
        const f = recoveryFixture(); const error = capacity(extra); let calls = 0;
        await assert.rejects(f.recovery.run(async () => { calls++; throw error; }), e => e === error);
        assert.equal(calls, 1); assert.deepEqual(f.waits, []);
    });
}
test('a server delay is honored and an excessive delay is never shortened', async () => {
    const f = recoveryFixture(); let calls = 0;
    await f.recovery.run(async () => { if (++calls === 1) throw capacity({ providerRetryAfterMs: 120000 }); });
    assert.deepEqual(f.waits, [120000]);
    const other = recoveryFixture();
    await assert.rejects(other.recovery.run(async () => { throw capacity({ providerRetryAfterMs: 300001 }); }), e => e.providerCapacityStopReason === 'retry-after-limit');
    assert.deepEqual(other.waits, []);
});
test('cancellation while waiting starts no replacement and releases the abort listener', async () => {
    const controller = new AbortController(); let calls = 0;
    const f = recoveryFixture({ wait: async () => controller.abort() });
    await assert.rejects(f.recovery.run(async () => { calls++; throw capacity(); }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

const sourceText = '合成の列車が到着します。案内を確認してください。';
const koreanText = '합성 열차가 도착합니다. 안내를 확인하세요.';
async function integration(t, handler, { count = 161, wait, pipeline = false } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-capacity-v1924-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 6 + .25, end: index * 6 + 4.75, text: sourceText }));
    const record = { id: 'owned-capacity', status: 'completed', name: 'owned.mp4', transcript, duration: count * 6 + 5,
        warnings: [], frames: [], summary: '합성 열차 안내', transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: true,
            duration: count * 6 + 5, processedUntil: count * 6 + 5, wordTimestamps: true, language: 'ja',
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], events = [], waits = [], stages = [], commits = [], controller = new AbortController();
    let time = 1000, active = 0, fixed = false;
    const provider = createNoKeyProvider({ environment: { VIDEORANDOM_CODEX: 'owned-codex', VIDEORANDOM_TRANSLATION_PIPELINE: pipeline ? 'on' : 'off' },
        now: () => time, capacityRandom: () => 0, capacityWait: async milliseconds => { waits.push(milliseconds); time += milliseconds; if (wait) await wait(controller); },
        spawnImpl: (binary, args) => {
            assert.equal(binary, 'owned-codex'); assert.equal(args[0], 'exec');
            assert.equal(args[args.indexOf('--model') + 1], policy.requestedModel);
            assert(args.includes('model_reasoning_effort="low"')); assert(args.includes('service_tier="default"'));
            const child = new EventEmitter(), chunks = []; let closed = false; active++;
            child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
            child.kill = () => queueMicrotask(() => close(null));
            child.stdin.on('data', bytes => chunks.push(bytes));
            child.stdin.on('finish', () => queueMicrotask(async () => {
                try {
                    const input = JSON.parse(Buffer.concat(chunks).toString().split('자료 JSON:\n').at(-1));
                    const call = { args, child, input, start: input.subtitles[0].index, review: !!input.draftSubtitles };
                    calls.push(call);
                    const problem = !fixed && await handler(call, calls);
                    if (problem === 'capacity') { child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } }) + '\n'); return; }
                    if (problem) { child.stderr.write(problem); close(1); return; }
                    const response = call.review ? { approvedIndexes: input.subtitles.map(cue => cue.index), corrections: [], terms: [] }
                        : { subtitles: input.subtitles.map(cue => ({ index: cue.index, text: koreanText })), terms: [] };
                    if (!closed) { await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(response)); close(0); }
                } catch (error) { child.stderr.write(error.message); close(1); }
            }));
            return child;
        } });
    return { calls, events, waits, stages, commits, record, transcript, controller, fix: () => { fixed = true; },
        run: () => provider.translateKoreanOnly(record, { dataDir, signal: controller.signal, subtitleQuality: 'accurate',
            onProgress: stage => stages.push(stage), onDiagnostic: event => events.push(event),
            onCheckpoint: value => commits.push(value.subtitleTranslationProgress.completedCues) }),
        drained: async () => { assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []); } };
}
for (const phase of ['draft', 'review']) test(`transient ${phase} congestion resumes the same source batch and reaches the exact final cue`, async t => {
    let first = true;
    const f = await integration(t, call => { if (first && call.start === 80 && call.review === (phase === 'review')) { first = false; return 'capacity'; } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError); assert.equal(result.subtitleTranslation.length, 161);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual(f.waits, [30000]); assert.equal(f.calls.length, 7);
    assert(f.stages.some(stage => stage.includes('모델 혼잡'))); assert(f.commits.includes(80));
    assert.deepEqual(result.codexModels.translation, policy);
    const warning = f.events.find(event => event.code === 'PROVIDER_CAPACITY');
    assert.equal(warning.level, 'warning'); assert.equal(warning.stage, phase === 'review' ? 'translation_review' : 'translation_draft');
    assert.equal(warning.providerRequestedModel, 'gpt-6-luna'); await f.drained();
});
test('persistent congestion keeps the reviewed checkpoint and a later explicit repair reuses only its exact source tail', async t => {
    const f = await integration(t, call => call.start === 80 ? 'capacity' : undefined);
    const first = await f.run();
    assert.equal(first.subtitleRepairStatus, 'failed'); assert.equal(first.subtitleDiagnostic.code, 'PROVIDER_CAPACITY');
    assert.equal(first.subtitleTranslationProgress.completedCues, 80); assert.deepEqual(f.waits, [30000, 60000]);
    assert(!f.calls.some(call => call.start === 160));
    assert.equal(classifyQueueRecord(first, { catalogSaved: true }).code, 'PROVIDER_CAPACITY');
    const before = f.calls.length; f.fix();
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.slice(before).map(call => call.start), [80, 80, 160, 160]);
    assert.equal(result.subtitleTranslation.length, 161); await f.drained();
});
for (const failure of ['401 authentication failed', 'quota usage limit', '503 service unavailable', 'execution timeout', 'ECONNRESET network failure', 'provider_refusal']) {
    test(`translation never replays ${failure} as model congestion`, async t => {
        const f = await integration(t, () => failure);
        const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'failed');
        assert.notEqual(result.subtitleDiagnostic.code, 'PROVIDER_CAPACITY'); assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
        await f.drained();
    });
}
test('user cancellation during a translation cooldown preserves saved cues and stops immediately', async t => {
    const f = await integration(t, call => call.start === 80 ? 'capacity' : undefined, { wait: controller => controller.abort() });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationProgress.completedCues, 80); assert.equal(f.calls.length, 3);
    await f.drained();
});

test('a prefetched draft capacity response does not cancel its current independent review', async t => {
    let first = true;
    const f = await integration(t, call => { if (first && !call.review && call.start === 160) { first = false; return 'capacity'; } }, { count: 401, pipeline: true });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 401); assert.equal(f.calls.length, 13);
    assert.deepEqual(f.waits, [30000]); assert(f.commits.includes(160)); await f.drained();
});

for (const [value, expected, invalid] of [
    ['120', 120000, false], ['Fri, 23 Oct 2026 01:02:00 GMT', 120000, false],
    ['Fri, 23 Oct 2026 00:59:00 GMT', 0, false], ['99999999', undefined, true],
    ['PRIVATE_HEADER', undefined, true], [['30'], undefined, true]
]) test(`Retry-After is honored or blocks replay without retaining header text: ${JSON.stringify(value)}`, async () => {
    const d = createProviderExecutionDiagnostics({ now: () => Date.parse('2026-10-23T01:00:00Z') });
    d.observeEvent({ type: 'error', error: { code: 'server_is_overloaded', status: 503, headers: { 'retry-after': value } } });
    const info = d.snapshot({ executionSource: 'provider-error' });
    assert.equal(info.providerRetryAfterMs, expected); assert.equal(info.providerRetryAfterInvalid === true, invalid);
    assert(!JSON.stringify(info).includes('PRIVATE_HEADER'));
    if (invalid) {
        const f = recoveryFixture(); let calls = 0;
        await assert.rejects(f.recovery.run(async () => { calls++; throw capacity(info); }), error => error.providerCapacityStopReason === 'retry-after-invalid');
        assert.equal(calls, 1); assert.deepEqual(f.waits, []);
    }
});

test('native cooldown aborts promptly and removes its listener without waiting thirty seconds', async () => {
    const controller = new AbortController(); let calls = 0;
    const recovery = createProviderCapacityRecovery();
    const running = recovery.run(async () => { calls++; throw capacity(); }, { signal: controller.signal,
        onRetry: () => setImmediate(() => controller.abort()) });
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(calls, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('summary congestion resumes the same neutral request and records its explicit model without calling speech', async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-summary-capacity-v1924-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    let requests = 0, time = 1000;
    const waits = [], events = [];
    const provider = createNoKeyProvider({ environment: { VIDEORANDOM_CODEX: 'owned-codex', VIDEORANDOM_PYTHON: 'owned-python' },
        now: () => time, capacityRandom: () => 0, capacityWait: async ms => { waits.push(ms); time += ms; },
        spawnImpl: (binary, args) => {
            const child = new EventEmitter(), chunks = []; let closed = false;
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
            const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
            child.kill = () => queueMicrotask(() => close(null));
            child.stdin.on('data', chunk => chunks.push(chunk));
            child.stdin.on('finish', () => queueMicrotask(async () => {
                try {
                    if (args.includes('login')) { child.stdout.write('Logged in using ChatGPT\n'); close(0); return; }
                    if (binary === 'owned-python') { assert(args.includes('import faster_whisper; print("ready")')); child.stdout.write('ready'); close(0); return; }
                    assert.equal(args[0], 'exec'); requests++;
                    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
                    if (requests === 1) { child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity.' } }) + '\n'); return; }
                    await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({
                        summary: '합성 역 안내', plot: '합성 역 안내 표본입니다.', dialogueSummary: '음성이 없는 표본입니다.', frames: [], labels: ['안내'], limitations: [] }));
                    close(0);
                } catch (error) { child.stderr.write(error.message); close(1); }
            }));
            return child;
        } });
    const record = { id: 'owned-summary', hasAudio: false, duration: 2, status: 'completed', transcript: [], frames: [], warnings: [] };
    const result = await provider.analyzeExtracted(record, { dataDir, onDiagnostic: event => events.push(event) });
    assert.equal(result.summaryError, null); assert.equal(result.summary, '합성 역 안내');
    assert.equal(requests, 2); assert.deepEqual(waits, [30000]); assert.deepEqual(result.codexModels.summary, policy);
    assert.equal(events.find(event => event.code === 'PROVIDER_CAPACITY').stage, 'summary');
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')), []);
});
