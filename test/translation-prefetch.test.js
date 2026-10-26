const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter, getEventListeners } = require('events');
const { PassThrough } = require('stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const originalText = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const translatedText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const response = call => ({ subtitles: call.input.subtitles.map(cue => ({ index: cue.index, text: translatedText })), terms: [] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t, { count = 480, environment = {}, handler, onCheckpoint, onDiagnostic, signal, quality = 'accurate' } = {}) {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'videorandom-translation-prefetch-'));
    t.after(() => fs.promises.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index}`, start: index * 6 + 0.25,
        end: index * 6 + 4.75, text: originalText }));
    const record = { id: 'synthetic-translation', name: 'synthetic.mp4', transcript, duration: count * 6 + 5, warnings: [], frames: [],
        transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3', summary: '보관된 합성 요약',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3', complete: true,
            duration: count * 6 + 5, processedUntil: count * 6 + 5, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], events = [];
    let active = 0, peak = 0, activeReviews = 0, peakReviews = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(args[0], 'exec', 'translation fixture never calls ASR, login probes or summary');
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const chunks = [], cancelled = deferred();
        const call = { child, args, cancelled: cancelled.promise, killed: false };
        let closed = false;
        active++; peak = Math.max(peak, active);
        const close = code => {
            if (closed) return;
            if (call.closeGate) { call.closeGate.promise.then(() => { call.closeGate = null; close(code); }); return; }
            closed = true; active--;
            if (call.review) activeReviews--;
            child.emit('close', code);
        };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.start = call.input.subtitles[0].index; call.count = call.input.subtitles.length; call.review = Boolean(call.input.draftSubtitles);
                if (call.review) { activeReviews++; peakReviews = Math.max(peakReviews, activeReviews); }
                calls.push(call);
                const result = handler ? await handler(call, { calls, commits, record }) : undefined;
                if (!closed) {
                    await fs.promises.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result || response(call)), 'utf8');
                    close(0);
                }
            } catch (error) {
                if (!closed) { child.stderr.write(error.message); close(error.exitCode || 1); }
            }
        }));
        return child;
    };
    const instance = createNoKeyProvider({ spawnImpl, environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex', ...environment }, platform: 'win32' });
    const run = options => instance.translateKoreanOnly(record, { dataDir, subtitleQuality: quality, signal,
        onCheckpoint: async value => { commits.push(value.subtitleTranslationProgress?.completedCues || 0); if (onCheckpoint) await onCheckpoint(value); },
        onDiagnostic: value => { events.push(value); if (onDiagnostic) onDiagnostic(value); }, ...options });
    const assertDrained = async () => {
        assert.equal(active, 0, 'every started child closes before translation returns');
        assert.deepEqual(await fs.promises.readdir(path.join(dataDir, 'tmp')).catch(() => []), [], 'every temporary request directory is removed');
        if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
    };
    return { dataDir, record, transcript, calls, commits, events, run, assertDrained, get peak() { return peak; }, get peakReviews() { return peakReviews; } };
}

test('accurate long translation overlaps one next draft after warmup while every review uses the latest committed context', async t => {
    const f = await fixture(t, { handler: async call => {
        await delay(8);
        const result = response(call);
        if (call.review) {
            assert.equal(call.input.previousTranslations.at(-1)?.index, call.start ? call.start - 1 : undefined);
            if (call.start) assert.ok(call.input.properNames.some(term => term.source === `合成人名${call.start - 80}`));
            result.terms.push({ source: `合成人名${call.start}`, translation: `합성 인명 ${call.start}` });
        }
        return result;
    } });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 12); assert.equal(f.peak, 2); assert.equal(f.peakReviews, 1);
    assert.deepEqual(f.calls.slice(0, 3).map(call => [call.start, call.review]), [[0, false], [0, true], [80, false]]);
    assert.deepEqual(f.transcript, original);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual([...new Set(f.commits)].filter(Boolean), [80, 160, 240, 320, 400, 480]);
    const checkpoint = JSON.parse(await fs.promises.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(checkpoint.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(checkpoint.terms.length, 6);
    await f.assertDrained();
});

for (const [label, options, expected] of [
    ['explicit pipeline off', { environment: { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } }, 12],
    ['fewer than four batches', { count: 319 }, 8], ['fast single pass', { quality: 'fast' }, 6]
]) test(`${label} preserves the serial request path`, async t => {
    const f = await fixture(t, { ...options, handler: async () => { await delay(1); } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.peak, 1); assert.equal(f.calls.length, expected);
    await f.assertDrained();
});

test('only a newly committed term conflict replaces one stale draft and reviews the replacement with current context', async t => {
    const f = await fixture(t, { handler: async call => {
        await delay(2);
        const result = response(call);
        if (call.review && call.start === 80) result.terms = [{ source: '太郎', translation: '타로' }];
        if (!call.review && call.start === 160) result.terms = [{ source: '太郎', translation: call.input.properNames.some(term => term.source === '太郎') ? '타로' : '다로' }];
        if (call.review && call.start === 160) {
            assert.deepEqual(call.input.draftTerms, [{ source: '太郎', translation: '타로' }]);
            assert.ok(call.input.properNames.some(term => term.source === '太郎' && term.translation === '타로'));
            result.terms = [{ source: '太郎', translation: '타로' }];
        }
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 2);
    assert.equal(f.calls.filter(call => call.start === 160 && call.review).length, 1);
    assert.equal(f.calls.length, 13);
    await f.assertDrained();
});

test('a stale replacement that still conflicts is repaired once then quarantined while later batches continue', async t => {
    const f = await fixture(t, { handler: async call => {
        await delay(1);
        const result = response(call);
        if (call.review && call.start === 80) result.terms = [{ source: '太郎', translation: '타로' }];
        if (!call.review && call.start === 160) result.terms = [{ source: '太郎', translation: '다로' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleError, null); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationPartial.length, 400);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 3);
    assert.equal(f.calls.some(call => call.start === 160 && call.review), false);
    assert(f.calls.some(call => call.start === 400 && call.review));
    await f.assertDrained();
});

test('an exact reviewed version-five checkpoint migrates without any new generation', async t => {
    const f = await fixture(t);
    assert.equal((await f.run()).subtitleRepairStatus, 'completed');
    const directory = path.join(f.dataDir, 'checkpoints');
    const filename = path.join(directory, f.record.id + '-ko.json');
    const saved = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
    saved.translationVersion = 5;
    await fs.promises.writeFile(filename, JSON.stringify(saved), 'utf8');
    for (const name of await fs.promises.readdir(directory)) {
        if (new RegExp(`^[a-f0-9]{64}-translation-ko-v${TRANSLATION_PROMPT_VERSION}\\.json$`).test(name)) await fs.promises.rm(path.join(directory, name));
    }
    f.calls.length = 0;
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, 0, 'same exact reviewed v5 source/timing/ID contract needs no new draft or review');
    assert.equal(JSON.parse(await fs.promises.readFile(filename, 'utf8')).translationVersion, TRANSLATION_PROMPT_VERSION);
    await f.assertDrained();
});

test('a conflict already present in the draft snapshot is bounded without cancelling the current review', async t => {
    const f = await fixture(t, { handler: async call => {
        if (call.start === 80 && call.review) { await delay(20); return response(call); }
        const result = response(call);
        if (call.review && call.start === 0) result.terms = [{ source: '太郎', translation: '타로' }];
        if (!call.review && call.start === 160) result.terms = [{ source: '太郎', translation: '다로' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleError, null); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationPartial.length, 400);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 2);
    await f.assertDrained();
});

for (const failure of ['503 Service Unavailable', '401 authentication failed', 'quota usage limit', 'execution timeout', 'safety refusal']) {
    test(`a prefetched ${failure} stops and cancels the active review without a retry`, async t => {
        const f = await fixture(t, { handler: async call => {
            if (call.start === 80 && call.review) { await call.cancelled; return response(call); }
            if (call.start === 160 && !call.review) throw new Error(`owned ${failure}`);
        } });
        const result = await f.run();
        assert.match(result.subtitleError, new RegExp(failure));
        assert.equal(result.subtitleTranslationPartial.length, 80);
        assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 1);
        assert.equal(f.calls.some(call => call.start > 160 || call.start === 160 && call.review), false);
        await f.assertDrained();
    });
}

for (const failure of ['refusal', 'missing array']) test(`a prefetched structured ${failure} keeps its own refusal or local validation boundary`, async t => {
    const f = await fixture(t, { handler: async call => {
        if (call.start === 80 && call.review) { if (failure === 'refusal') await call.cancelled; else await delay(20); return response(call); }
        if (call.start === 160 && !call.review) {
            const result = response(call);
            if (failure === 'refusal') result.subtitles[0].text = '이 요청의 번역을 제공할 수 없습니다.';
            return failure === 'missing array' ? { terms: [] } : result;
        }
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, failure === 'refusal' ? 'failed' : 'partial');
    assert.equal(result.subtitleTranslationPartial.length, failure === 'refusal' ? 80 : 400);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, failure === 'refusal' ? 1 : 2);
    if (failure !== 'refusal') assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    await f.assertDrained();
});

test('a prefetched invalid index is repaired after the preceding review commits and preserves the remaining source tail', async t => {
    const draftReady = deferred();
    const f = await fixture(t, { handler: async (call, state) => {
        if (call.start === 80 && call.review) await draftReady.promise;
        const result = response(call);
        if (call.start === 160 && !call.review && call.count === 80) {
            result.subtitles[0].index = -1;
            draftReady.resolve();
        }
        if (call.start === 160 && !call.review && call.count === 1) {
            assert(state.commits.includes(160), 'the prior independent review must be durably committed before malformed-row recovery starts');
        }
        return result;
    } });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review && call.count === 1).length, 1);
    assert(f.calls.some(call => call.review && call.input.subtitles.at(-1).index === original.length - 1));
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), original.map(cue => [cue.id, cue.start, cue.end]));
    assert.deepEqual(f.transcript, original);
    await f.assertDrained();
});

test('prefetched missing cues are repaired only after the previous review is durably committed', async t => {
    const f = await fixture(t, { handler: async (call, state) => {
        await delay(2);
        const result = response(call);
        if (!call.review && call.start === 160 && call.count === 80) result.subtitles.pop();
        if (!call.review && call.start === 239) {
            assert.ok(state.commits.includes(160), 'missing-cue request waits for the preceding durable checkpoint');
            assert.ok(call.input.properNames.some(term => term.source === '太郎' && term.translation === '타로'));
        }
        if (call.review && call.start === 80) result.terms = [{ source: '太郎', translation: '타로' }];
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.filter(call => call.start === 239 && !call.review).length, 1);
    assert.equal(f.calls.length, 13); assert.ok(f.peak <= 2);
    await f.assertDrained();
});

test('a non-clean warmup keeps the first following batch fully serial before any lookahead starts', async t => {
    const f = await fixture(t, { count: 1819, handler: call => {
        const result = response(call);
        if (call.review && call.start === 0 && call.count === 80) result.subtitles.pop();
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.slice(0, 5).map(call => [call.start, call.count, call.review]),
        [[0, 80, false], [0, 80, true], [79, 1, true], [80, 80, false], [80, 80, true]]);
    assert.equal(result.subtitleTranslation.length, 1819);
    await f.assertDrained();
});

test('a current-review missing-cue repair discards lookahead before its repair request and resumes in source order', async t => {
    let firstPrefetch = true;
    const f = await fixture(t, { handler: async call => {
        if (call.start === 160 && !call.review && firstPrefetch) { firstPrefetch = false; await call.cancelled; }
        const result = response(call);
        if (call.start === 80 && call.review && call.count === 80) result.subtitles.pop();
        if (call.start === 159 && call.review) {
            const discarded = f.calls.find(item => item.start === 160 && !item.review);
            assert.equal(discarded.killed, true, 'speculative child closes before a missing review is requested');
        }
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.filter(call => call.start === 159 && call.review).length, 1);
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 2);
    assert.equal(f.events.some(event => event.code === 'ANALYSIS_CANCELLED'), false);
    await f.assertDrained();
});

test('a prefetched service failure prevents local length correction from retrying any request', async t => {
    const f = await fixture(t, { handler: async call => {
        if (call.start === 80 && call.review) {
            await call.cancelled;
            const result = response(call); result.subtitles.forEach(cue => { cue.text = '네.'; }); return result;
        }
        if (call.start === 160 && !call.review) throw new Error('owned first prefetched 503');
    } });
    const result = await f.run();
    assert.match(result.subtitleError, /owned first prefetched 503/);
    assert.equal(result.subtitleTranslationPartial.length, 80);
    assert.equal(f.calls.some(call => call.count === 20), false);
    await f.assertDrained();
});

test('a streaming prefetched 503 cancels the current review before delayed child close and drains before return', async t => {
    const closeGate = deferred(), failed = deferred(), finishReview = deferred();
    let returned = false;
    const f = await fixture(t, { handler: async call => {
        if (call.start === 80 && call.review) await finishReview.promise;
        if (call.start === 160 && !call.review) {
            call.closeGate = closeGate;
            call.child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: '503 owned delayed prefetched close' } }) + '\n');
            failed.resolve(); await closeGate.promise;
        }
    } });
    const pending = f.run().finally(() => { returned = true; });
    await failed.promise; finishReview.resolve();
    for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    assert.equal(f.calls.some(call => call.start > 160 || call.start === 160 && call.review), false);
    closeGate.resolve();
    const result = await pending;
    assert.match(result.subtitleError, /503 owned delayed prefetched close/);
    assert.equal(result.subtitleTranslationPartial.length, 80);
    await f.assertDrained();
});

test('parent abort drains the overlapping review and draft while retaining only the reviewed prefix', async t => {
    const controller = new AbortController(), ready = deferred(); let overlapping = 0;
    const f = await fixture(t, { signal: controller.signal, handler: async call => {
        if (call.start === 80 && call.review || call.start === 160 && !call.review) {
            if (++overlapping === 2) ready.resolve();
            await call.cancelled;
        }
    } });
    const pending = f.run(); await ready.promise; controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationPartial.length, 80);
    assert.ok(f.calls.length <= 5);
    await f.assertDrained();
});

test('current review service failure cancels the next draft and preserves the first error', async t => {
    const ready = deferred(); let overlapping = 0;
    const f = await fixture(t, { handler: async call => {
        if (call.start === 80 && call.review || call.start === 160 && !call.review) {
            if (++overlapping === 2) ready.resolve();
            await ready.promise;
            if (call.review) throw new Error('owned current review failure');
            await call.cancelled;
        }
    } });
    const result = await f.run();
    assert.match(result.subtitleError, /owned current review failure/);
    assert.equal(result.subtitleTranslationPartial.length, 80);
    assert.equal(f.calls.some(call => call.start > 160), false);
    await f.assertDrained();
});

test('a reviewed Korean length difference preserves lookahead and does not repeat drafts or review requests', async t => {
    const f = await fixture(t, { handler: async call => {
        const result = response(call);
        if (call.start === 80 && call.review && call.count === 80) result.subtitles.forEach(cue => { cue.text = '네.'; });
        return result;
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(f.calls.length, Math.ceil(f.transcript.length / 80) * 2, 'length alone adds no repair requests');
    assert.equal(f.calls.filter(call => call.start === 160 && !call.review).length, 1);
    assert.equal(f.calls.some(call => call.count === 20 || call.killed), false);
    assert.equal(f.peakReviews, 1);
    assert(result.subtitleTranslation.slice(80, 160).every(cue => cue.text === '네.'));
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert(f.events.some(event => event.code === 'SUBTITLE_LENGTH_REVIEW' && event.level === 'warning'));
    assert.equal(f.events.some(event => event.code === 'ANALYSIS_CANCELLED'), false, 'discarded speculative work is not reported as an analysis failure');
    await f.assertDrained();
});

for (const count of [480, 1819]) test(`synthetic ${count}-cue latency comparison preserves request count, source, timing and complete output`, async t => {
    const handler = async () => { await delay(12); };
    const serial = await fixture(t, { count, handler, environment: { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } });
    const pooled = await fixture(t, { count, handler });
    const serialStart = performance.now(); const oldResult = await serial.run(); const serialElapsed = performance.now() - serialStart;
    const poolStart = performance.now(); const result = await pooled.run(); const pooledElapsed = performance.now() - poolStart;
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(serial.calls.length, Math.ceil(count / 80) * 2); assert.equal(pooled.calls.length, serial.calls.length);
    assert.deepEqual(result.subtitleTranslation, oldResult.subtitleTranslation);
    assert.deepEqual(pooled.transcript, serial.transcript); assert.equal(serial.peak, 1); assert.equal(pooled.peak, 2); assert.equal(pooled.peakReviews, 1);
    t.diagnostic(`Owned synthetic ${count}-cue translation, 12 ms/request: serial ${serialElapsed.toFixed(1)} ms; draft lookahead ${pooledElapsed.toFixed(1)} ms; same ${pooled.calls.length} requests. No real provider or video was processed.`);
    await serial.assertDrained(); await pooled.assertDrained();
});
