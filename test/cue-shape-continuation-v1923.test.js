const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');
const { subtitleText } = require('../lib/subtitle-utils');

const SOURCE = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const KOREAN = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const OTHER = '합성 열차의 다음 안내입니다. 승강장 안쪽에서 기다리고 출발 시간을 확인하세요.';
const plain = value => value.replace(/\s+/g, ' ').trim();
const shapes = {
    'missing index': index => ({ text: KOREAN }),
    'string index': index => ({ index: String(index), text: KOREAN }),
    'fractional index': index => ({ index: index + 0.5, text: KOREAN }),
    'unknown index': index => ({ index: 999999, text: KOREAN }),
    'empty text': index => ({ index, text: ' \n ' }),
    'non-string text': index => ({ index, text: { text: KOREAN } }),
    'oversized text': index => ({ index, text: '합'.repeat(10001) }),
    'unsafe text': index => ({ index, text: '```\n합성 안내\n```' })
};

async function fixture(t, { count = 161, bad = [81], phase = 'draft', profile = 'accurate', compact = true,
    shape = 'missing index', handler, pipeline = false } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-shape-v1923-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-shape-${index}`,
        start: index * 7 + 0.125, end: index * 7 + 5.375, text: SOURCE }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-shape-result', name: 'owned-synthetic-train.mp4', summary: '합성 열차 안내',
        status: 'completed', transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja',
        transcriptSource: 'audio:faster-whisper large-v3', transcriptionQuality: {
            version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: []
        } };
    const calls = [], diagnostics = [], checkpoints = [], controller = new AbortController();
    const badIndexes = new Set(bad); let fixed = false, active = 0;
    const affected = call => call.review === (phase === 'review');
    const badRow = index => shape.endsWith('duplicate')
        ? [{ index, text: KOREAN }, { index, text: shape === 'identical duplicate' ? KOREAN : OTHER }] : [shapes[shape](index)];
    const normalResponse = call => call.review && compact
        ? { approvedIndexes: [...call.indexes], corrections: [], terms: [] }
        : { subtitles: call.indexes.map(index => ({ index, text: KOREAN })), terms: [] };
    const damagedResponse = call => {
        if (fixed || !affected(call) || !call.indexes.some(index => badIndexes.has(index))) return normalResponse(call);
        if (call.review && compact) return {
            approvedIndexes: call.indexes.filter(index => !badIndexes.has(index)),
            corrections: call.indexes.filter(index => badIndexes.has(index)).flatMap(badRow), terms: []
        };
        return { subtitles: call.indexes.flatMap(index => badIndexes.has(index) ? badRow(index) : [{ index, text: KOREAN }]), terms: [] };
    };
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-shape-codex'); assert.equal(args[0], 'exec', 'only the synthetic provider is callable');
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
                const response = handler ? await handler(call, { calls, damagedResponse, normalResponse, controller }) : undefined;
                if (closed) return;
                call.response = response === undefined ? damagedResponse(call) : response;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1],
                    typeof call.response === 'string' ? call.response : JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: {
        VIDEORANDOM_CODEX: 'owned-shape-codex', VIDEORANDOM_TRANSLATION_PIPELINE: pipeline ? 'on' : 'off'
    } });
    return { dataDir, record, transcript, calls, diagnostics, checkpoints, controller, fix: () => { fixed = true; },
        run: options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile, signal: controller.signal,
            onDiagnostic: event => diagnostics.push(event),
            onCheckpoint: value => checkpoints.push(structuredClone(value.subtitleTranslationProgress)), ...options }),
        drained: async () => {
            assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
            assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
        } };
}

function assertPartial(result, source, missing) {
    const expected = source.map((_, index) => index).filter(index => !missing.includes(index));
    assert.equal(result.subtitleRepairStatus, 'partial', result.subtitleError);
    assert.equal(result.subtitleError, null); assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, source.length);
    assert.equal(result.subtitleTranslationProgress.completedCues, expected.length);
    assert.equal(result.subtitleTranslationProgress.totalCues, source.length);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.equal(result.subtitleTranslation, undefined); assert.equal(result.subtitleLanguage, undefined);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, expected);
    assert.deepEqual(result.transcript, source);
    assert.equal(result.subtitleTranslationPartial.length, expected.length);
    result.subtitleTranslationPartial.forEach((cue, offset) => {
        const original = source[expected[offset]];
        assert.deepEqual([cue.id, cue.start, cue.end], [original.id, original.start, original.end]);
        assert.equal(plain(cue.text), KOREAN, 'only an unambiguous validated Korean cue can be approved');
    });
    const srt = subtitleText(result, { language: 'ko', partial: true });
    assert.equal((srt.match(/ --> /g) || []).length, expected.length);
    for (const unwanted of ['```', '999999', SOURCE, OTHER, '[object Object]']) assert(!srt.includes(unwanted));
}

const modes = [
    ['accurate compact draft', { profile: 'accurate', compact: true, phase: 'draft' }],
    ['accurate full draft', { profile: 'accurate', compact: false, phase: 'draft' }],
    ['accurate compact review', { profile: 'accurate', compact: true, phase: 'review' }],
    ['accurate full review', { profile: 'accurate', compact: false, phase: 'review' }],
    ['fast draft', { profile: 'fast', phase: 'draft' }],
    ['turbo draft', { profile: 'turbo', phase: 'draft' }]
];
for (const [mode, options] of modes) for (const shape of [...Object.keys(shapes), 'identical duplicate', 'conflicting duplicate']) {
    test(`${mode} isolates a persistent ${shape}, preserves neighbors and visits the final original cue`, async t => {
        const f = await fixture(t, { ...options, shape }); const original = structuredClone(f.transcript);
        const result = await f.run(); assertPartial(result, original, [81]);
        assert(f.diagnostics.some(event => event.code === 'SUBTITLE_ROWS_INVALID' && event.level === 'warning'));
        assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-shape-160');
        assert(f.calls.some(call => !call.review && call.indexes.includes(160)), 'later source must still be translated');
        if (options.phase === 'draft' && options.profile === 'accurate') assert(!f.calls.some(call => call.review && call.indexes.includes(81)),
            'an invalid draft row must never become an approval input');
        const repairCalls = f.calls.filter(call => call.review === (options.phase === 'review') && call.count < 80 && call.indexes.includes(81));
        assert(repairCalls.length >= 1 && repairCalls.length <= 2, 'same-source corrections are bounded and never recursively replay a batch');
        if (options.profile !== 'accurate') assert(f.calls.every(call => !call.review));
        const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
        assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(saved.completedCues, 160);
        assert(!saved.subtitles.some(cue => cue.index === 81));
        assert(saved.subtitles.every(cue => Number.isSafeInteger(cue.index) && cue.index >= 0 && cue.index < 161));
        await f.drained();
    });
}

for (const phase of ['draft', 'review']) test(`a corrected ${phase} row can complete without shifting source IDs or cue times`, async t => {
    let damaged = false;
    const f = await fixture(t, { phase, handler: (call, state) => {
        if (call.review === (phase === 'review') && call.indexes.includes(81)) {
            if (!damaged) { damaged = true; return state.damagedResponse(call); }
            return state.normalResponse(call);
        }
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 161);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert(result.subtitleTranslation.every(cue => plain(cue.text) === KOREAN)); await f.drained();
});

for (const phase of ['draft', 'review']) test(`a synthetic 2007-cue ${phase} job with malformed row 880 reaches cue 2006 and later repairs only its hole`, async t => {
    const f = await fixture(t, { count: 2007, phase, shape: 'string index', bad: [880] });
    const first = await f.run(); assertPartial(first, f.transcript, [880]);
    assert.equal(first.subtitleTranslationPartial.at(-1).id, 'owned-shape-2006');
    assert(f.calls.some(call => call.review && call.indexes.includes(2006)));
    const retained = structuredClone(first.subtitleTranslationPartial);
    f.calls.length = 0; f.fix();
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.deepEqual(f.calls.map(call => call.indexes), [[880], [880]], 'the reviewed tail must not be translated again');
    assert.equal(result.subtitleTranslation.length, 2007);
    for (const cue of retained) assert.deepEqual(result.subtitleTranslation.find(value => value.id === cue.id), cue);
    await f.drained();
});

test('a malformed prefetched accurate draft is discarded safely and cannot abort later valid source', async t => {
    const f = await fixture(t, { count: 321, bad: [161], shape: 'missing index', pipeline: true });
    const result = await f.run(); assertPartial(result, f.transcript, [161]);
    assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-shape-320');
    await f.drained();
});

test('an empty successful draft uses only the shared correction ceiling and then continues to the valid tail', async t => {
    const f = await fixture(t, { count: 241, bad: [], handler: call => {
        if (!call.review && call.indexes.every(index => index < 80)) return { subtitles: [], terms: [] };
    } });
    const result = await f.run(); assertPartial(result, f.transcript, Array.from({ length: 80 }, (_, index) => index));
    const corrections = f.calls.filter(call => !call.review && call.count < 80 && call.indexes.every(index => index < 80));
    assert.equal(corrections.length, 64, 'empty rows never create an unbounded retry loop');
    assert(!f.calls.some(call => call.review && call.indexes.some(index => index < 80)), 'an empty draft cannot acquire default approval');
    assert.equal(result.subtitleTranslationPartial.at(-1).id, 'owned-shape-240');
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT')); await f.drained();
});

const hardStops = {
    'field refusal': () => ({ refusal: 'owned-synthetic-provider-refusal' }),
    'subtitle refusal': call => ({ subtitles: call.indexes.map(index => ({ index, text: '이 요청의 번역을 제공할 수 없습니다.' })), terms: [] }),
    'execution refusal': () => { throw new Error('Owned synthetic safety refusal'); },
    authentication: () => { throw new Error('Owned synthetic 401 authentication failed'); },
    quota: () => { throw new Error('Owned synthetic quota usage limit'); },
    unavailable: () => { throw new Error('Owned synthetic 503 service unavailable'); },
    timeout: () => { throw new Error('Owned synthetic execution timeout'); },
    network: () => { throw new Error('Owned synthetic ECONNRESET network failure'); },
    'malformed JSON': () => '{malformed-owned-response',
    'unknown execution failure': () => { throw new Error('Owned synthetic execution failed'); }
};
for (const phase of ['draft', 'review']) for (const [name, fail] of Object.entries(hardStops)) {
    test(`a later ${phase} ${name} still stops immediately after an isolated malformed row`, async t => {
        const f = await fixture(t, { count: 241, bad: [0], phase: 'draft', handler: call => {
            if (call.start === 80 && call.review === (phase === 'review')) return fail(call);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed'); assert.notEqual(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
        assert.equal(f.calls.at(-1).start, 80); assert.equal(f.calls.at(-1).review, phase === 'review');
        assert(!f.calls.some(call => call.start >= 160), 'shared/provider/execution failures cannot be bypassed');
        assert.equal(result.subtitleTranslationProgress.completedCues, 79);
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, Array.from({ length: 79 }, (_, index) => index + 1));
        await f.drained();
    });
}

test('a refusal hidden in an unknown malformed row stops before any correction or neighboring approval', async t => {
    const f = await fixture(t, { count: 80, handler: call => ({ subtitles: [
        ...call.indexes.map(index => ({ index, text: KOREAN })),
        { index: 'unknown', text: '이 요청의 번역을 제공할 수 없습니다.' }
    ], terms: [] }) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED');
    assert.equal(f.calls.length, 1); assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

test('a compact review refusal in an unknown correction stops before any correction or neighboring approval', async t => {
    const f = await fixture(t, { count: 80, bad: [], handler: call => call.review ? {
        approvedIndexes: [...call.indexes], corrections: [{ index: 'unknown', text: '이 요청의 번역을 제공할 수 없습니다.' }], terms: []
    } : undefined });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_REFUSAL_TEXT_DETECTED');
    assert.equal(f.calls.length, 2); assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    await f.drained();
});

test('an explicit compact review refusal field takes precedence over refusal text in a malformed correction and launches no further request', async t => {
    const f = await fixture(t, { count: 161, bad: [], handler: call => call.review ? {
        refusal: 'owned-synthetic-provider-refusal', approvedIndexes: [...call.indexes],
        corrections: [{ index: 'unknown', text: '이 요청의 번역을 제공할 수 없습니다.' }], terms: []
    } : undefined });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_PROVIDER_REFUSAL');
    assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
    assert.deepEqual(f.calls.map(call => [call.start, call.count, call.review]), [[0, 80, false], [0, 80, true]],
        'an explicit service refusal cannot trigger correction or the next independent source batch');
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
    await f.drained();
});

test('user cancellation after a sparse malformed-row checkpoint preserves approved cues and launches no next batch', async t => {
    const f = await fixture(t, { count: 241, bad: [0], handler: (call, state) => {
        if (!call.review && call.start === 80) state.controller.abort();
    } });
    await assert.rejects(f.run(), error => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.record.subtitleTranslationProgress.completedCues, 79);
        return true;
    });
    assert.equal(f.calls.at(-1).start, 80); assert(!f.calls.some(call => call.start >= 160)); await f.drained();
});
