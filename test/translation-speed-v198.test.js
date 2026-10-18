const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const sourceText = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const koreanText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = call => ({ subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: koreanText })), terms: [] });

async function fixture(t, { count = 320, quality = 'accurate', environment = {}, handler, checkpointIO, onCheckpoint } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-speed-v198-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 7 + 0.5,
        end: index * 7 + 5.5, text: sourceText }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-v198-translation', name: 'owned-synthetic-train.mp4', transcript, duration, warnings: [], frames: [],
        summary: '보관된 합성 열차 안내', transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: true,
            duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], diagnostics = [], controller = new AbortController();
    let active = 0, peak = 0, activeReviews = 0, peakReviews = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex');
        assert.equal(args[0], 'exec', 'no actual provider, model, source video, ASR or login command is called');
        const child = new EventEmitter(), chunks = [], cancelled = deferred();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, cancelled: cancelled.promise, killed: false };
        active++; peak = Math.max(peak, active);
        let closed = false;
        const close = code => {
            if (closed) return;
            closed = true; active--;
            if (call.review) activeReviews--;
            child.emit('close', code);
        };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.start = call.input.subtitles[0].index; call.count = call.input.subtitles.length;
                call.review = Boolean(call.input.draftSubtitles);
                if (call.review) { activeReviews++; peakReviews = Math.max(peakReviews, activeReviews); }
                calls.push(call);
                const result = handler ? await handler(call, { calls, commits, record }) : undefined;
                if (closed) return;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result || response(call)), 'utf8');
                close(0);
            } catch (error) {
                if (!closed) { child.stderr.write(error.message); close(1); }
            }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex', ...environment },
        platform: 'win32', ...(checkpointIO ? { checkpointIO } : {}) });
    const run = options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: quality, signal: controller.signal,
        onCheckpoint: async value => {
            commits.push(value.subtitleTranslationProgress?.completedCues || 0);
            if (onCheckpoint) await onCheckpoint(value);
        }, onDiagnostic: value => diagnostics.push(value), ...options });
    const assertDrained = async () => {
        assert.equal(active, 0, 'every started synthetic child closes before return');
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    };
    return { dataDir, record, transcript, calls, commits, diagnostics, controller, run, assertDrained,
        get peak() { return peak; }, get peakReviews() { return peakReviews; } };
}

for (const count of [320, 400, 479]) test(`accurate ${count}-cue subtitles overlap one draft after a durable warmup without skipping any final review`, async t => {
    const nextDraftReady = deferred();
    const f = await fixture(t, { count, handler: async (call, state) => {
        await delay(3);
        assert(call.count <= 80);
        assert(call.input.subtitles.reduce((length, cue) => length + cue.text.length, 0) <= 12000);
        if (call.review) {
            assert.equal(call.input.previousTranslations.at(-1)?.index, call.start ? call.start - 1 : undefined);
            if (call.start) assert(state.commits.includes(call.start), 'latest review follows the preceding durable checkpoint');
            if (call.start === 80) await nextDraftReady.promise;
        }
        if (call.start === 160 && !call.review) {
            assert(state.commits.includes(80), 'speculation waits for a fully reviewed first batch');
            assert(!state.commits.includes(160), 'the next draft overlaps the preceding review');
            nextDraftReady.resolve();
        }
    } });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, Math.ceil(count / 80) * 2);
    assert.equal(f.peak, 2); assert.equal(f.peakReviews, 1);
    assert.deepEqual(f.calls.slice(0, 3).map(call => [call.start, call.review]), [[0, false], [0, true], [80, false]]);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual(f.transcript, original);
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.translationVersion, 6); assert.equal(TRANSLATION_PROMPT_VERSION, 6);
    assert.equal(saved.reviewPasses, 2); assert.equal(saved.completedCues, count);
    await f.assertDrained();
});

for (const [label, options, requests] of [
    ['fewer than four batches', { count: 319 }, 8],
    ['explicit sequential override', { environment: { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } }, 8],
    ['fast single pass', { quality: 'fast' }, 4]
]) test(`${label} retains its original sequential behavior`, async t => {
    const f = await fixture(t, { ...options, handler: () => delay(2) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.peak, 1); assert.equal(f.calls.length, requests);
    await f.assertDrained();
});

test('a warmup provider refusal stops before any next draft and preserves its detection source', async t => {
    const f = await fixture(t, { handler: call => call.review ? { refusal: true } : response(call) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_PROVIDER_REFUSAL');
    assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert.deepEqual(f.calls.map(call => [call.start, call.review]), [[0, false], [0, true]]);
    await f.assertDrained();
});

for (const failure of ['503 service unavailable', '401 authentication failure', 'quota usage limit']) {
    test(`shorter accurate pipeline immediately cancels a sibling on ${failure} without retry`, async t => {
        const ready = deferred(); let started = 0;
        const f = await fixture(t, { handler: async call => {
            if (call.start === 80 && call.review || call.start === 160 && !call.review) {
                if (++started === 2) ready.resolve();
                await ready.promise;
                if (call.review) await call.cancelled;
                else throw new Error(`owned ${failure}`);
            }
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert(result.subtitleError.includes(failure));
        assert.equal(result.subtitleTranslationPartial.length, 80);
        assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 1);
        assert(!f.calls.some(call => call.start > 160 || call.start === 160 && call.review));
        assert(f.calls.find(call => call.start === 80 && call.review).killed);
        await f.assertDrained();
    });
}

test('a newly committed term gets one current-context replacement and never skips the sequential final review', async t => {
    const f = await fixture(t, { handler: async call => {
        await delay(3);
        const result = response(call);
        if (call.review && call.start === 80) result.terms = [{ source: '太郎', translation: '타로' }];
        if (!call.review && call.start === 160) result.terms = [{ source: '太郎',
            translation: call.input.properNames.some(term => term.source === '太郎') ? '타로' : '다로' }];
        if (call.review && call.start === 160) {
            assert.deepEqual(call.input.draftTerms, [{ source: '太郎', translation: '타로' }]);
            assert(call.input.properNames.some(term => term.source === '太郎' && term.translation === '타로'));
            result.terms = [{ source: '太郎', translation: '타로' }];
        }
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 9);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 2);
    assert.equal(f.calls.filter(call => call.start === 160 && call.review).length, 1);
    assert.equal(f.peakReviews, 1);
    await f.assertDrained();
});

test('an exact reviewed shorter translation reuses its complete cache without any new account requests', async t => {
    const f = await fixture(t);
    assert.equal((await f.run()).subtitleRepairStatus, 'completed');
    const initialCount = f.calls.length;
    const saved = structuredClone(f.record.subtitleTranslation);
    assert.equal((await f.run()).subtitleRepairStatus, 'completed');
    assert.equal(f.calls.length, initialCount);
    assert.deepEqual(f.record.subtitleTranslation, saved);
    await f.assertDrained();
});

for (const count of [320, 479, 1819]) test(`synthetic ${count}-cue v198 latency comparison retains the same source, reviewed output and request count`, async t => {
    const handler = () => delay(15);
    const sequential = await fixture(t, { count, handler, environment: { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } });
    const pipelined = await fixture(t, { count, handler });
    const sequentialStart = performance.now(); const before = await sequential.run(); const sequentialMs = performance.now() - sequentialStart;
    const pipelinedStart = performance.now(); const after = await pipelined.run(); const pipelinedMs = performance.now() - pipelinedStart;
    assert.equal(before.subtitleRepairStatus, 'completed'); assert.equal(after.subtitleRepairStatus, 'completed');
    assert.deepEqual(after.subtitleTranslation, before.subtitleTranslation);
    assert.equal(pipelined.calls.length, sequential.calls.length);
    assert.equal(sequential.peak, 1); assert.equal(pipelined.peak, 2); assert.equal(pipelined.peakReviews, 1);
    t.diagnostic(`Owned synthetic ${count} cues at 15 ms/request: sequential ${sequentialMs.toFixed(1)} ms; pipelined ${pipelinedMs.toFixed(1)} ms; same ${pipelined.calls.length} requests. No actual video or provider was processed.`);
    await sequential.assertDrained(); await pipelined.assertDrained();
});
