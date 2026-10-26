const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const sourceText = '合成の列車が到着します。安全のためにホームの内側で待ち、案内と出発時間を確認してください。';
const koreanText = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
const textFor = index => koreanText + ' 합성 안내 번호 ' + index + '번입니다.';
const unwrapped = text => text.replace(/\s+/g, ' ').trim();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { count = 160, bad = [], profile = 'accurate', pipeline = false, handler } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-count-recovery-v1916-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-count-${index}`,
        start: index * 7 + 0.5, end: index * 7 + 5.5, text: sourceText }));
    const duration = count * 7 + 6;
    const record = { id: 'owned-count-record', name: 'owned-synthetic-train.mp4', summary: '보관한 합성 안내',
        transcript, duration, warnings: [], frames: [], transcriptLanguage: 'ja', transcriptSource: 'audio:faster-whisper large-v3',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], commits = [], diagnostics = [], controller = new AbortController();
    let active = 0, peak = 0, fixed = false;
    const badIndexes = new Set(bad);
    const normalResponse = call => call.review ? { approvedIndexes: call.indexes.slice(), corrections: [], terms: [] }
        : { subtitles: call.indexes.map(index => ({ index, text: !fixed && badIndexes.has(index) ? '네.' : textFor(index) })), terms: [] };
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-synthetic-codex'); assert.equal(args[0], 'exec');
        const child = new EventEmitter(), chunks = [], cancelled = deferred();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        const call = { args, child, cancelled: cancelled.promise, killed: false };
        active++; peak = Math.max(peak, active);
        let closed = false;
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        child.kill = () => { call.killed = true; cancelled.resolve(); queueMicrotask(() => close(null)); };
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                call.input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                call.indexes = call.input.subtitles.map(cue => cue.index); call.start = call.indexes[0];
                call.count = call.indexes.length; call.review = Boolean(call.input.draftSubtitles);
                calls.push(call);
                const response = handler ? await handler(call, { calls, record, controller, normalResponse, commits }) : undefined;
                if (closed) return;
                call.response = response || normalResponse(call);
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(call.response), 'utf8');
                close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-synthetic-codex',
        ...(pipeline ? {} : { VIDEORANDOM_TRANSLATION_PIPELINE: 'off' }) } });
    const run = options => provider.translateKoreanOnly(record, { dataDir, subtitleQuality: profile, signal: controller.signal,
        onCheckpoint: value => commits.push(JSON.parse(JSON.stringify(value.subtitleTranslationProgress || {}))),
        onDiagnostic: value => diagnostics.push(value), ...options });
    const drained = async () => {
        assert.equal(active, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []);
    };
    return { dataDir, record, transcript, calls, commits, diagnostics, controller, run, drained,
        fix: () => { fixed = true; }, get peak() { return peak; } };
}


const indexes = count => Array.from({ length: count }, (_, index) => index);
const responseFor = entries => ({ subtitles: entries.map(entry => ({ index: entry.index, text: textFor(entry.index) })), terms: [] });
const reviewFor = entries => ({ approvedIndexes: entries.map(entry => entry.index), corrections: [], terms: [] });
function assertIdentity(result, source, accepted = indexes(source.length)) {
    const cues = result.subtitleTranslation || result.subtitleTranslationPartial;
    assert.equal(cues.length, accepted.length);
    cues.forEach((cue, offset) => {
        const index = accepted[offset];
        assert.deepEqual([cue.id, cue.start, cue.end], [source[index].id, source[index].start, source[index].end]);
        assert.equal(unwrapped(cue.text), textFor(index));
    });
}
function assertComplete(result, source) {
    assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslationProgress.completedCues, source.length);
    assert.equal(result.subtitleTranslationProgress.complete, true);
    assert.equal(result.subtitleTranslationProgress.translationComplete, true);
    assert.equal(result.subtitleTranslationProgress.sourceComplete, true);
    assert.equal(result.subtitleTranslationProgress.version, 1);
    assertIdentity(result, source);
}
function assertPending(result, source, missing) {
    const accepted = indexes(source.length).filter(index => !missing.includes(index));
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationProgress.processingComplete, true);
    assert.equal(result.subtitleTranslationProgress.processedCues, source.length);
    assert.equal(result.subtitleTranslation, undefined);
    assert.equal(result.subtitleTranslationProgress.completedCues, accepted.length);
    assert.equal(result.subtitleTranslationProgress.complete, false);
    assert.equal(result.subtitleTranslationProgress.translationComplete, false);
    assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, accepted);
    assertIdentity(result, source, accepted);
}

for (const shape of ['compact', 'legacy']) test(`1819 cues recover a successful empty ${shape} review after 240 reviewed source cues and reach the exact final cue`, async t => {
    let empty = false;
    const f = await fixture(t, { count: 1819, handler: (call, state) => {
        if (!empty && call.review && call.start === 240 && call.count === 80) {
            empty = true;
            return shape === 'compact' ? { approvedIndexes: [], corrections: [], terms: [] } : { subtitles: [], terms: [] };
        }
        return state.normalResponse(call);
    } });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assertComplete(result, original);
    assert.deepEqual(f.transcript, original);
    const corrections = f.calls.filter(call => call.review && call.start >= 240 && call.start < 320 && call.count < 80);
    assert.deepEqual(corrections.map(call => call.indexes), [indexes(20).map(index => index + 240), indexes(20).map(index => index + 260),
        indexes(20).map(index => index + 280), indexes(20).map(index => index + 300)]);
    assert(f.commits.some(progress => progress.completedCues === 240));
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 1818));
    await f.drained();
});

for (const profile of ['fast', 'turbo', 'accurate']) test(`2000 ${profile} cues recover a valid partial indexed supplement using only its remaining singleton`, async t => {
    let initial = false, supplemental = false;
    const f = await fixture(t, { count: 2000, profile, handler: (call, state) => {
        const final = profile === 'accurate' ? call.review : !call.review;
        if (final && call.start === 0 && call.count === 80 && !initial) {
            initial = true;
            return responseFor(call.input.subtitles.filter(entry => ![5, 19].includes(entry.index)));
        }
        if (final && call.count === 2 && !supplemental) { supplemental = true; return responseFor(call.input.subtitles.filter(entry => entry.index !== 5)); }
        return state.normalResponse(call);
    } });
    const result = await f.run(); assertComplete(result, f.transcript);
    const corrections = f.calls.filter(call => call.start < 80 && call.count < 80);
    assert.deepEqual(corrections.map(call => call.indexes), [[5, 19], [5]]);
    assert(f.calls.some(call => call.indexes.at(-1) === 1999));
    await f.drained();
});

test('2000 accurate cues retain an unresolved empty singleton, continue the final source batch, and resume only that original index', async t => {
    let fixed = false;
    const f = await fixture(t, { count: 2000, handler: (call, state) => {
        if (!fixed && call.review && call.indexes.includes(21)) return reviewFor(call.input.subtitles.filter(entry => entry.index !== 21));
        return state.normalResponse(call);
    } });
    const first = await f.run(); assertPending(first, f.transcript, [21]);
    assert.deepEqual(f.calls.filter(call => call.review && call.count === 1).map(call => call.indexes), [[21]], 'a repeated empty singleton is bounded and never assumed approved');
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 1999));
    const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', f.record.id + '-ko.json'), 'utf8'));
    assert.equal(saved.version, 2); assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION);
    assert.equal(saved.reviewPasses, 2); assert.equal(saved.complete, false);
    f.calls.length = 0; fixed = true;
    const repaired = await f.run(); assertComplete(repaired, f.transcript);
    assert.deepEqual(f.calls.map(call => call.indexes), [[21], [21]]);
    await f.drained();
});

test('a 64-request bounded accurate draft gap reviews only explicit available draft indexes and preserves the 2000-cue tail', async t => {
    let fixed = false;
    const f = await fixture(t, { count: 2000, handler: (call, state) => {
        if (!fixed && !call.review && call.start < 80) return responseFor(call.input.subtitles.slice(0, 1));
        if (call.review) {
            assert.deepEqual(call.input.draftSubtitles.map(cue => cue.index), call.indexes);
            for (const cue of call.input.draftSubtitles) assert.equal(unwrapped(cue.text), textFor(cue.index), 'a source hole cannot shift subsequent draft text');
        }
        return state.normalResponse(call);
    } });
    const first = await f.run(); assertPending(first, f.transcript, indexes(15).map(index => index + 65));
    const repairs = f.calls.filter(call => !call.review && call.start < 80 && call.count < 80);
    assert.equal(repairs.length, 64);
    assert.deepEqual(f.calls.find(call => call.review).indexes, indexes(65));
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 1999));
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT' && event.level === 'warning'));
    f.calls.length = 0; fixed = true;
    const completed = await f.run(); assertComplete(completed, f.transcript);
    assert.deepEqual(f.calls.map(call => call.indexes), [indexes(15).map(index => index + 65), indexes(15).map(index => index + 65)]);
    await f.drained();
});

test('successful empty reviews consume at most64 corrections, leave every unchecked cue pending, and continue later source batches', async t => {
    const f = await fixture(t, { count: 2000, handler: (call, state) => call.review && call.start < 80
        ? { approvedIndexes: [], corrections: [], terms: [] } : state.normalResponse(call) });
    const result = await f.run(); assertPending(result, f.transcript, indexes(80));
    assert.equal(f.calls.filter(call => call.review && call.start < 80 && call.count < 80).length, 64);
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 1999));
    assert(f.diagnostics.some(event => event.code === 'SUBTITLE_REPAIR_LIMIT'));
    await f.drained();
});

for (const failure of ['503 service unavailable', '401 authentication failed', 'quota usage limit', 'execution timeout', 'ECONNRESET network failure', 'response refusal']) {
    test(`a singleton ${failure} hard-stops without refetch or later source work while retaining its already reviewed tail`, async t => {
        const f = await fixture(t, { count: 160, handler: (call, state) => {
            if (call.review && call.count === 80) return reviewFor(call.input.subtitles.filter(entry => ![5, 19].includes(entry.index)));
            if (call.review && call.count === 2) return reviewFor(call.input.subtitles.filter(entry => entry.index !== 5));
            if (call.review && call.count === 1) {
                if (failure === 'response refusal') return { refusal: true };
                throw new Error('Owned synthetic ' + failure);
            }
            return state.normalResponse(call);
        } });
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(f.calls.length, 4); assert(!f.calls.some(call => call.start >= 80));
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, indexes(80).filter(index => index !== 5));
        assertIdentity(result, f.transcript, indexes(80).filter(index => index !== 5));
        if (failure === 'response refusal') assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
        else assert(result.subtitleError.includes(failure));
        await f.drained();
    });
}

const recoverableRows = {
    duplicate: entries => ({ subtitles: [{ index: entries[0].index, text: textFor(0) }, { index: entries[0].index, text: textFor(0) }], terms: [] }),
    excess: entries => responseFor([...entries, entries[0]]),
    'out-of-range': () => ({ subtitles: [{ index: 99999, text: koreanText }], terms: [] }),
    'empty text': entries => ({ subtitles: [{ index: entries[0].index, text: '' }], terms: [] }),
    'unsafe subtitle formatting': entries => ({ subtitles: [{ index: entries[0].index, text: '```\n합성 안내\n```' }], terms: [] }),
    'empty array': () => ({ subtitles: [], terms: [] }),
    'empty array without schema terms': () => ({ subtitles: [] })
};
for (const phase of ['draft', 'review']) for (const [name, respond] of Object.entries(recoverableRows)) test(`a ${phase} ${name} leaves only uncertified rows pending and still processes the final source batch`, async t => {
    const f = await fixture(t, { count: 160, handler: (call, state) => call.review === (phase === 'review') && call.start < 80
        ? respond(call.input.subtitles) : state.normalResponse(call) });
    const original = structuredClone(f.transcript);
    const result = await f.run();
    assertPending(result, original, name === 'excess' ? [0] : indexes(80));
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 159), 'a malformed earlier row cannot prevent the final independent source cues from being reviewed');
    const corrections = f.calls.filter(call => call.review === (phase === 'review') && call.start < 80 && call.count < 80);
    assert(corrections.length > 0 && corrections.length <= 64, 'all row repairs share the existing per-video limit');
    assert(corrections.every(call => call.count <= 20));
    assert.deepEqual(f.transcript, original);
    await f.drained();
});

const invalid = {
    'missing array': () => ({ terms: [] }),
    'null array': () => ({ subtitles: null, terms: [] }),
    'unknown empty-result field': () => ({ subtitles: [], terms: [], unexpected: true }),
    'invalid empty-result terms': () => ({ subtitles: [], terms: [{ source: '合成駅' }] })
};
for (const phase of ['draft', 'review']) for (const [name, respond] of Object.entries(invalid)) test(`a ${phase} ${name} gets one bounded format repair per batch then leaves unverified source pending`, async t => {
    const f = await fixture(t, { count: 160, handler: (call, state) => call.review === (phase === 'review') ? respond(call.input.subtitles) : state.normalResponse(call) });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(f.calls.length, phase === 'draft' ? 4 : 6);
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert(f.calls.some(call => call.start >= 80));
    assert.equal(result.subtitleTranslationProgress.processingComplete, true); await f.drained();
});

test('empty review recovery cannot omit required draft name confirmation', async t => {
    const term = { source: '合成駅', translation: '합성역' };
    const f = await fixture(t, { count: 80, handler: (call, state) => {
        if (!call.review) return { ...state.normalResponse(call), terms: [term] };
        if (call.count === 80) return { approvedIndexes: [], corrections: [], terms: [] };
        return state.normalResponse(call);
    } });
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert.equal(f.calls.length, 11); await f.drained();
});
