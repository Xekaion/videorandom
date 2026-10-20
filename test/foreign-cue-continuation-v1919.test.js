const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');
const { subtitleText } = require('../lib/subtitle-utils');

const SOURCE = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const KOREAN = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const FOREIGN = '合成の列車が到着します。ホームの内側で待ち、出発時間を確認してください。';
const plain = text => text.replace(/\s+/g, ' ').trim();

async function fixture(t, { count = 161, bad = [81], phase = 'review', profile = 'accurate', compact = true, handler } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-foreign-v1919-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-foreign-${index}`,
        start: index * 7 + 0.125, end: index * 7 + 5.375, text: SOURCE }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-foreign-result', name: 'owned-synthetic-train.mp4', summary: '합성 열차 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], diagnostics = [], checkpoints = [], controller = new AbortController();
    const badIndexes = new Set(bad); let fixed = false, active = 0;
    const isForeign = (call, index) => !fixed && badIndexes.has(index) && call.review === (phase === 'review');
    const normalResponse = call => {
        if (call.review && compact) return { approvedIndexes: call.indexes.filter(index => !isForeign(call, index)),
            corrections: call.indexes.filter(index => isForeign(call, index)).map(index => ({ index, text: FOREIGN })), terms: [] };
        return { subtitles: call.indexes.map(index => ({ index, text: isForeign(call, index) ? FOREIGN : KOREAN })), terms: [] };
    };
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex'); assert.equal(args[0], 'exec', 'no real media, recognition, status or provider calls');
        const child = new EventEmitter(), chunks = []; let closed = false;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const call = { args, child, killed: false }; active++;
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => { call.killed = true; queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index); call.count = call.indexes.length;
                call.start = call.indexes[0]; call.review = Boolean(call.input.draftSubtitles); calls.push(call);
                const response = handler ? await handler(call, { calls, normalResponse, controller }) : undefined;
                if (closed) return;
                call.response = response === undefined ? normalResponse(call) : response;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1],
                    typeof call.response === 'string' ? call.response : JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
        VIDEORANDOM_CODEX: 'owned-synthetic-codex', VIDEORANDOM_TRANSLATION_PIPELINE: 'off' } });
    return { dataDir, record, transcript, calls, diagnostics, checkpoints, controller, fix: () => { fixed = true; },
        run: options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile, signal: controller.signal,
            onDiagnostic: event => diagnostics.push(event),
            onCheckpoint: value => checkpoints.push(structuredClone(value.subtitleTranslationProgress)), ...options }),
        drained: async () => {
            assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
        } };
}

function assertAcceptedExcept(result, source, missing) {
    const expected = source.map((_, index) => index).filter(index => !missing.includes(index));
    const progress = result.subtitleTranslationProgress;
    assert.equal(progress.completedCues, expected.length); assert.equal(progress.totalCues, source.length);
    assert.equal(progress.complete, false); assert.equal(progress.translationComplete, false);
    assert.equal(progress.processingComplete, true); assert.equal(progress.processedCues, source.length);
    assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.status, 'partial');
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.deepEqual(progress.version === 2 ? progress.cueIndexes : expected.map((_, index) => index), expected);
    assert.equal(result.subtitleTranslationPartial.length, expected.length);
    result.subtitleTranslationPartial.forEach((cue, offset) => {
        const original = source[expected[offset]];
        assert.deepEqual([cue.id, cue.start, cue.end], [original.id, original.start, original.end]);
        assert.equal(plain(cue.text), KOREAN);
    });
    assert.deepEqual(result.transcript, source);
    const srt = subtitleText(result, { language: 'ko', partial: true });
    assert(!srt.includes(FOREIGN), 'untranslated content is never emitted as Korean SRT');
    assert.equal((srt.match(/ --> /g) || []).length, expected.length);
}

const modes = [
    ['accurate compact draft', { profile: 'accurate', compact: true, phase: 'draft' }],
    ['accurate full draft', { profile: 'accurate', compact: false, phase: 'draft' }],
    ['accurate compact review', { profile: 'accurate', compact: true, phase: 'review' }],
    ['accurate full review', { profile: 'accurate', compact: false, phase: 'review' }],
    ['fast draft', { profile: 'fast', phase: 'draft' }],
    ['turbo draft', { profile: 'turbo', phase: 'draft' }]
];
for (const [name, mode] of modes) for (const index of [0, 81, 160]) {
    test(`${name} isolates persistent foreign cue ${index} and processes the remaining original timeline`, async t => {
        const f = await fixture(t, { ...mode, bad: [index] }); const original = structuredClone(f.transcript);
        const result = await f.run(); assertAcceptedExcept(result, original, [index]);
        const correction = f.calls.filter(call => call.review === (mode.phase === 'review') && call.count === 1 && call.indexes[0] === index);
        // The final source batch itself has one cue; only its second call is a correction.
        assert.equal(correction.length, index === 160 ? 2 : 1, 'foreign content gets one bounded same-source correction, without recursive retry');
        assert(f.calls.some(call => !call.review && call.indexes.includes(160)), 'the actual final source cue is attempted');
        if (index !== 160) assert.equal(result.subtitleTranslationPartial.at(-1).id, original.at(-1).id);
        if (mode.phase === 'draft' && mode.profile === 'accurate') {
            assert(!f.calls.some(call => call.review && call.indexes.includes(index)), 'an invalid draft cannot be approved by a reviewer');
        }
        if (mode.profile !== 'accurate') assert(f.calls.every(call => !call.review));
        assert(f.diagnostics.some(event => event.code === 'SUBTITLE_FOREIGN_TEXT' && event.level === 'warning'));
        const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
        assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION);
        assert.equal(saved.reviewPasses, mode.profile === 'accurate' ? 2 : 1);
        assert.equal(saved.completedCues, 160); assert(!saved.subtitles.some(cue => cue.index === index));
        await f.drained();
    });
}

for (const phase of ['draft', 'review']) test(`a foreign ${phase} cue corrected once can finish without losing any original ID or interval`, async t => {
    let first = true;
    const f = await fixture(t, { bad: [81], phase, handler: (call, state) => {
        const response = state.normalResponse(call);
        if (call.review === (phase === 'review') && call.indexes.includes(81)) {
            if (first) first = false;
            else return call.review ? { approvedIndexes: [], corrections: [{ index: 81, text: KOREAN }], terms: [] }
                : { subtitles: [{ index: 81, text: KOREAN }], terms: [] };
        }
        return response;
    } });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 161);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslation.every(cue => plain(cue.text) === KOREAN)); await f.drained();
});

for (const [phase, compact] of [['draft', true], ['review', true], ['review', false]]) {
    test(`2019-cue ${compact ? 'compact' : 'full'} ${phase} keeps late Korean cues after foreign entries at 0, 1000 and 2017`, async t => {
        const f = await fixture(t, { count: 2019, bad: [0, 1000, 2017], phase, compact });
        const result = await f.run(); assertAcceptedExcept(result, f.transcript, [0, 1000, 2017]);
        assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-foreign-2018');
        assert.deepEqual(f.calls.filter(call => call.review === (phase === 'review') && call.count === 1).map(call => call.indexes[0]), [0, 1000, 2017]);
        assert(f.calls.some(call => call.review && call.indexes.includes(2018)), 'review reaches the final source index, beyond all damaged batches');
        await f.drained();
    });
}

test('resuming a sparse foreign-content result requests only its remaining holes and retains accepted later text', async t => {
    const f = await fixture(t, { bad: [0, 81, 160] });
    const first = await f.run(); assertAcceptedExcept(first, f.transcript, [0, 81, 160]);
    const retained = structuredClone(first.subtitleTranslationPartial);
    f.calls.length = 0; f.fix(); const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => call.indexes), [[0, 81, 160], [0, 81, 160]]);
    assert.equal(result.subtitleTranslationProgress.complete, true); assert.equal(result.subtitleTranslation.length, 161);
    for (const cue of retained) assert.deepEqual(result.subtitleTranslation.find(value => value.id === cue.id), cue);
    await f.drained();
});

test('an entirely foreign accurate draft is skipped after bounded corrections while later valid source still reaches review', async t => {
    const f = await fixture(t, { bad: Array.from({ length: 80 }, (_, index) => index), phase: 'draft' });
    const result = await f.run(); assertAcceptedExcept(result, f.transcript, Array.from({ length: 80 }, (_, index) => index));
    assert.deepEqual(f.calls.filter(call => !call.review && call.start < 80).map(call => call.count), [80, 20, 20, 20, 20]);
    assert(f.calls.filter(call => call.review).every(call => call.start >= 80), 'zero valid draft rows never trigger an empty review request');
    assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-foreign-160'); await f.drained();
});

test('an all-foreign accurate draft cannot publish unchecked terminology over a retained reviewed prefix or into its valid tail', async t => {
    const reviewedTerm = { source: '合成駅', translation: '합성역' };
    const uncheckedTerm = { source: '未確認駅', translation: '미확인역' };
    const bad = Array.from({ length: 80 }, (_, index) => index + 80);
    const f = await fixture(t, { count: 241, bad, phase: 'draft', handler: (call, state) => {
        const result = state.normalResponse(call);
        if (!call.review && call.indexes.every(index => index >= 80 && index < 160)) result.terms = [uncheckedTerm];
        return result;
    } });
    const directory = path.join(f.dataDir, 'checkpoints'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, f.record.id + '-ko.json'), JSON.stringify({
        version: 1, translationVersion: TRANSLATION_PROMPT_VERSION, targetLanguage: 'ko', subtitleQuality: 'accurate', reviewPasses: 2,
        language: 'ko', sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(f.transcript.map(cue =>
            [cue.id, cue.start, cue.end, cue.text]))).digest('hex'),
        totalCues: 241, completedCues: 80, complete: false, sourceComplete: true, translationComplete: false,
        subtitles: f.transcript.slice(0, 80).map((cue, index) => ({ ...cue, index, text: KOREAN })), terms: [reviewedTerm]
    }), 'utf8');
    const result = await f.run(); assertAcceptedExcept(result, f.transcript, bad);
    assert.equal(f.calls[0].start, 80, 'the first new batch follows the exact retained reviewed prefix');
    assert.deepEqual(f.calls.filter(call => call.start < 160).map(call => [call.review, call.count]),
        [[false, 80], [false, 20], [false, 20], [false, 20], [false, 20]]);
    const tailCalls = f.calls.filter(call => call.start >= 160);
    assert(tailCalls.some(call => !call.review) && tailCalls.some(call => call.review));
    for (const call of tailCalls) assert.deepEqual(call.input.properNames, [reviewedTerm],
        'only terminology already independently reviewed may influence the next source batch');
    for (const filename of await fs.readdir(directory)) {
        const saved = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
        assert.deepEqual(saved.terms, [reviewedTerm], 'neither record nor content checkpoint may certify an unchecked draft term');
    }
    assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-foreign-240'); await f.drained();
});

test('foreign-content corrections share the operation-wide 64-request ceiling and later valid batches still finish', async t => {
    const bad = Array.from({ length: 1440 }, (_, index) => index);
    const f = await fixture(t, { count: 1601, bad, phase: 'draft' });
    const result = await f.run(); assertAcceptedExcept(result, f.transcript, bad);
    const corrections = f.calls.filter(call => !call.review && call.count === 20);
    assert.equal(corrections.length, 64); assert(corrections.every(call => call.indexes.every(index => index < 1280)));
    assert(f.calls.some(call => !call.review && call.start === 1360 && call.count === 80), 'normal source batches continue after the repair budget is exhausted');
    assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-foreign-1600');
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT')); await f.drained();
});

test('an all-foreign accurate source finishes its traversal with zero approved cues and cannot export a false Korean SRT', async t => {
    const f = await fixture(t, { count: 80, bad: Array.from({ length: 80 }, (_, index) => index), phase: 'draft' });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleError, null);
    assert.equal(result.subtitleTranslationProgress.processingComplete, true); assert.equal(result.subtitleTranslationProgress.processedCues, 80);
    assert.equal(result.subtitleTranslationProgress.completedCues, 0); assert.equal(result.subtitleTranslationProgress.totalCues, 80);
    assert.equal(result.subtitleTranslationProgress.complete, false); assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleLanguage, undefined);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert.throws(() => subtitleText(result, { language: 'ko', partial: true }));
    assert.deepEqual(f.calls.map(call => [call.review, call.count]), [[false, 80], [false, 20], [false, 20], [false, 20], [false, 20]]);
    await f.drained();
});

for (const phase of ['draft', 'review']) for (const corruption of ['wrong index', 'duplicate index', 'conflicting terms', 'subtitle refusal']) {
    test(`${phase} foreign text cannot hide a sibling ${corruption} or start a correction`, async t => {
        const f = await fixture(t, { count: 80, bad: [0], phase, handler: call => {
            if (call.review !== (phase === 'review')) return undefined;
            const subtitles = call.indexes.map(index => ({ index, text: index === 0 ? FOREIGN : KOREAN }));
            const terms = [];
            if (corruption === 'wrong index') subtitles[1].index = 99999;
            if (corruption === 'duplicate index') subtitles[1].index = 0;
            if (corruption === 'conflicting terms') terms.push({ source: '合成駅', translation: '합성역' }, { source: '合成駅', translation: '다른역' });
            if (corruption === 'subtitle refusal') subtitles[1].text = '이 요청의 번역을 제공할 수 없습니다.';
            return { subtitles, terms };
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.notEqual(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.equal(f.calls.length, phase === 'draft' ? 1 : 2);
        assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
        assert.equal(result.subtitleTranslationPartial?.length || 0, 0); await f.drained();
    });
}

const failures = {
    'field refusal': () => ({ refusal: 'owned-synthetic-provider-refusal' }),
    'subtitle refusal': call => ({ subtitles: call.indexes.map(index => ({ index, text: '이 요청의 번역을 제공할 수 없습니다.' })), terms: [] }),
    'execution refusal': () => { throw new Error('Owned synthetic safety refusal'); },
    authentication: () => { throw new Error('Owned synthetic 401 authentication failed'); },
    quota: () => { throw new Error('Owned synthetic quota usage limit'); },
    unavailable: () => { throw new Error('Owned synthetic 503 service unavailable'); },
    timeout: () => { throw new Error('Owned synthetic execution timeout'); },
    network: () => { throw new Error('Owned synthetic ECONNRESET network failure'); },
    'malformed JSON': () => '{malformed-owned-response',
    'wrong index': call => ({ subtitles: call.indexes.map((index, offset) => ({ index: offset ? index : 99999, text: KOREAN })), terms: [] }),
    'duplicate index': call => ({ subtitles: call.indexes.map((index, offset) => ({ index: offset === 1 ? call.indexes[0] : index, text: KOREAN })), terms: [] }),
    'unsafe subtitle formatting': call => ({ subtitles: call.indexes.map(index => ({ index, text: '```\n합성 안내\n```' })), terms: [] })
};
for (const phase of ['draft', 'review']) for (const [name, fail] of Object.entries(failures)) {
    test(`a later ${phase} ${name} still stops immediately after an earlier recoverable foreign cue`, async t => {
        const f = await fixture(t, { count: 241, bad: [0], phase: 'review', handler: (call, state) => {
            if (call.start === 80 && call.review === (phase === 'review')) return fail(call);
            return state.normalResponse(call);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.notEqual(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
        assert.equal(f.calls.at(-1).start, 80); assert.equal(f.calls.at(-1).review, phase === 'review');
        assert(!f.calls.some(call => call.start >= 160), 'a hard stop cannot be bypassed through the next source batch');
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, Array.from({ length: 79 }, (_, index) => index + 1));
        assert.equal(result.subtitleTranslationProgress.completedCues, 79);
        assert(result.subtitleTranslationPartial.every(cue => plain(cue.text) === KOREAN));
        await f.drained();
    });
}

test('cancellation after a foreign-content checkpoint preserves its accepted neighbors and starts no later request', async t => {
    const f = await fixture(t, { count: 241, bad: [0], handler: (call, state) => {
        if (!call.review && call.start === 80) state.controller.abort();
        return state.normalResponse(call);
    } });
    await assert.rejects(f.run(), error => {
        assert.equal(error.name, 'AbortError');
        assert.deepEqual(error.record.subtitleTranslationProgress.cueIndexes, Array.from({ length: 79 }, (_, index) => index + 1));
        return true;
    });
    assert.equal(f.calls.at(-1).start, 80); assert(!f.calls.some(call => call.start >= 160)); await f.drained();
});
