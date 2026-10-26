const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createNoKeyProvider, TRANSLATION_PROMPT_VERSION } = require('../lib/no-key-provider');

const SOURCE = '合成列車の案内です。到着時刻と行き先を確認してホームの内側でお待ちください。';
const KOREAN = '합성 열차 안내입니다. 도착 시각과 목적지를 확인하고 승강장 안쪽에서 기다려 주세요.';
const TERM = { source: '合成駅', translation: '합성역' };
const normal = call => call.review ? { approvedIndexes: [...call.indexes], corrections: [], terms: [TERM] }
    : { subtitles: call.indexes.map(index => ({ index, text: KOREAN })), terms: [TERM] };

async function fixture(t, handler, { count = 161, pipeline = false, full = false } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-validation-v1928-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const duration = count * 6 + 5;
    const transcript = Array.from({ length: count }, (_, index) => ({ id: `neutral-${index}`, start: index * 6 + 0.25,
        end: index * 6 + 4.75, text: SOURCE }));
    const record = { id: 'neutral-train', name: 'neutral-train.mp4', duration, transcript, warnings: [], frames: [],
        hasAudio: true, transcriptSource: 'audio:faster-whisper large-v3', transcriptLanguage: 'ja', summary: '합성 열차 안내',
        transcriptionQuality: { version: 1, recognitionRevision: 3, source: 'audio', profile: 'accurate', model: 'large-v3',
            complete: true, duration, processedUntil: duration, wordTimestamps: true, language: 'ja', languageProbability: 0.99,
            audit: { complete: true, speechSeconds: 10, uncoveredSpeechSeconds: 0, unresolved: [] }, warnings: [] } };
    const calls = [], events = [], controller = new AbortController(); let active = 0;
    const spawnImpl = (binary, args) => {
        assert.equal(binary, 'owned-neutral-codex');
        const child = new EventEmitter(), chunks = []; let closed = false;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const close = code => { if (!closed) { closed = true; active--; child.emit('close', code); } };
        active++; child.kill = () => queueMicrotask(() => close(null));
        child.stdin.on('data', chunk => chunks.push(chunk));
        child.stdin.on('finish', () => queueMicrotask(async () => {
            try {
                if (args.includes('login')) { child.stderr.write('Logged in using ChatGPT\n'); close(0); return; }
                const input = JSON.parse(Buffer.concat(chunks).toString('utf8').split('자료 JSON:\n').at(-1));
                const call = { input, child, args, review: Boolean(input.draftSubtitles), summary: !Array.isArray(input.subtitles),
                    indexes: input.subtitles?.map(cue => cue.index) || [] };
                call.start = call.indexes[0]; calls.push(call);
                const response = await handler(call, { calls, normal, controller });
                if (closed) return;
                await fs.writeFile(args[args.indexOf('--output-last-message') + 1], typeof response === 'string' ? response
                    : JSON.stringify(response === undefined ? normal(call) : response), 'utf8'); close(0);
            } catch (error) { if (!closed) { child.stderr.write(error.message); close(1); } }
        }));
        return child;
    };
    const provider = createNoKeyProvider({ spawnImpl, platform: 'win32', environment: { VIDEORANDOM_CODEX: 'owned-neutral-codex',
        VIDEORANDOM_TRANSLATION_PIPELINE: pipeline ? 'on' : 'off' } });
    return { dataDir, record, transcript, calls, events, controller,
        run: options => full ? provider.analyzeExtracted(record, { dataDir, subtitleLanguage: 'ko', subtitleQuality: 'accurate',
            signal: controller.signal, onDiagnostic: event => events.push(event), ...options })
            : provider.translateKoreanOnly(record, { dataDir, subtitleQuality: 'accurate', signal: controller.signal,
                onDiagnostic: event => events.push(event), ...options }),
        drained: async () => { assert.equal(active, 0); assert.deepEqual(await fs.readdir(path.join(dataDir, 'tmp')).catch(() => []), []); } };
}

const invalid = {
    'term array': call => ({ ...normal(call), terms: {} }),
    'term shape': call => ({ ...normal(call), terms: [{ source: '合成駅' }] }),
    'conflicting terms': call => ({ ...normal(call), terms: [TERM, { ...TERM, translation: '다른 역' }] }),
    'changed committed term': call => ({ ...normal(call), terms: [{ ...TERM, translation: '다른 역' }] }),
    'missing subtitle array': () => ({ terms: [] }),
    'unknown response field': call => ({ ...normal(call), unexpected: true })
};
for (const phase of ['draft', 'review']) for (const [name, damage] of Object.entries(invalid)) {
    test(`a persistent ${phase} ${name} is bounded, quarantined and cannot cancel the final source batch`, async t => {
        const f = await fixture(t, call => call.start === 80 && call.review === (phase === 'review') ? damage(call) : undefined);
        const result = await f.run();
        assert.equal(result.subtitleRepairStatus, 'partial'); assert.equal(result.subtitleError, null);
        assert.equal(result.subtitleDiagnostic.code, 'SUBTITLE_CUES_PENDING');
        assert.equal(result.subtitleTranslationProgress.processingComplete, true);
        assert.equal(result.subtitleTranslationProgress.processedCues, 161);
        assert.equal(result.subtitleTranslationProgress.completedCues, 81);
        assert.deepEqual(result.subtitleTranslationProgress.cueIndexes, [...Array.from({ length: 80 }, (_, index) => index), 160]);
        assert(f.calls.some(call => call.review && call.start === 160));
        assert.equal(f.calls.filter(call => call.start === 80 && call.review === (phase === 'review')).length, 2);
        assert(!f.calls.some(call => call.start === 80 && call.review && phase === 'draft'));
        result.subtitleTranslationPartial.forEach(cue => {
            const source = f.transcript.find(value => value.id === cue.id);
            assert.deepEqual([cue.start, cue.end], [source.start, source.end]);
            assert.equal(cue.text.replace(/\s+/g, ' '), KOREAN);
        });
        const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'checkpoints', 'neutral-train-ko.json'), 'utf8'));
        assert.equal(saved.translationVersion, TRANSLATION_PROMPT_VERSION); assert.equal(saved.reviewPasses, 2);
        assert.deepEqual(saved.terms, [TERM]); await f.drained();
    });
}

for (const phase of ['draft', 'review']) test(`one normal ${phase} metadata repair can complete the whole source`, async t => {
    let damaged = false;
    const f = await fixture(t, call => {
        if (call.start === 80 && call.review === (phase === 'review') && !damaged) { damaged = true; return invalid['term shape'](call); }
    });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation.length, 161);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    assert.equal(f.calls.filter(call => call.start === 80 && call.review === (phase === 'review')).length, 2); await f.drained();
});

test('missing accurate review term confirmation never approves an unreviewed draft but later batches still run', async t => {
    const f = await fixture(t, call => call.review && call.start === 80 ? { ...normal(call), terms: [] } : undefined);
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleTranslationProgress.completedCues, 81);
    assert(!result.subtitleTranslationPartial.some(cue => cue.id === 'neutral-80'));
    assert(f.calls.some(call => call.review && call.start === 160)); await f.drained();
});

test('a malformed prefetched metadata response cannot poison the already running review', async t => {
    const f = await fixture(t, async call => {
        if (call.review && call.start === 80) await new Promise(resolve => setTimeout(resolve, 20));
        if (!call.review && call.start === 160) return invalid['term shape'](call);
    }, { count: 321, pipeline: true });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleTranslationProgress.completedCues, 241);
    assert(result.subtitleTranslationPartial.some(cue => cue.id === 'neutral-80'));
    assert(result.subtitleTranslationPartial.some(cue => cue.id === 'neutral-320')); await f.drained();
});

test('a later format repair cannot replace text that already reached its reviewed checkpoint', async t => {
    let initialReview = true;
    const repairedText = '합성 열차의 안내를 확인했습니다. 목적지와 도착 시각을 확인하고 승강장 안쪽에서 기다리세요.';
    const f = await fixture(t, call => {
        if (!call.review || call.start >= 80) return;
        if (call.indexes.length === 80 && initialReview) {
            initialReview = false;
            return { approvedIndexes: call.indexes.filter(index => ![5, 19].includes(index)), corrections: [], terms: [TERM] };
        }
        if (call.indexes.length === 2) return { approvedIndexes: [19], corrections: [], terms: [TERM] };
        if (call.indexes.length === 1) return { approvedIndexes: null, corrections: [], terms: [TERM] };
        return { approvedIndexes: [], corrections: call.indexes.map(index => ({ index, text: repairedText })), terms: [TERM] };
    }, { count: 160 });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'completed', result.subtitleError);
    assert.equal(result.subtitleTranslation[0].text.replace(/\s+/g, ' '), KOREAN);
    assert.equal(result.subtitleTranslation[19].text.replace(/\s+/g, ' '), KOREAN);
    assert.equal(result.subtitleTranslation[5].text.replace(/\s+/g, ' '), repairedText);
    assert.deepEqual(result.subtitleTranslation.map(cue => [cue.id, cue.start, cue.end]), f.transcript.map(cue => [cue.id, cue.start, cue.end]));
    await f.drained();
});

test('whole-batch metadata repairs share the existing 64-request ceiling across the entire source', async t => {
    const count = 5281, batches = Math.ceil(count / 80);
    const f = await fixture(t, call => invalid['term shape'](call), { count });
    const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'partial');
    assert.equal(result.subtitleTranslationProgress.processedCues, count);
    assert.equal(result.subtitleTranslationProgress.completedCues, 0);
    assert.equal(f.calls.length, batches + 64);
    assert.equal(f.calls.at(-1).indexes.at(-1), count - 1);
    assert(f.calls.every(call => !call.review), 'no malformed draft can acquire a default review approval');
    await f.drained();
});

const hardStops = {
    'provider envelope': () => ({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Owned synthetic service failure' } }),
    'structured refusal': () => ({ refusal: 'Owned synthetic refusal' }),
    'subtitle refusal': call => ({ ...normal(call), subtitles: [{ index: call.start, text: '이 요청의 번역을 제공할 수 없습니다.' }] }),
    authentication: () => { throw new Error('Owned synthetic 401 authentication failed'); },
    quota: () => { throw new Error('Owned synthetic quota usage limit'); },
    timeout: () => { throw new Error('Owned synthetic execution timeout'); },
    unavailable: () => { throw new Error('Owned synthetic 503 service unavailable'); },
    network: () => { throw new Error('Owned synthetic ECONNRESET network failure'); },
    'malformed JSON': () => '{owned synthetic malformed response',
    unknown: () => { throw new Error('Owned synthetic execution failed'); }
};
for (const phase of ['draft', 'review']) for (const [name, fail] of Object.entries(hardStops)) {
    test(`a ${phase} ${name} after a local format failure still stops without another provider request`, async t => {
        let damaged = false;
        const f = await fixture(t, call => {
            if (call.start !== 80 || call.review !== (phase === 'review')) return;
            if (!damaged) { damaged = true; return invalid['term shape'](call); }
            return fail(call);
        });
        const result = await f.run(); assert.equal(result.subtitleRepairStatus, 'failed');
        assert.equal(f.calls.filter(call => call.start === 80 && call.review === (phase === 'review')).length, 2);
        assert(!f.calls.some(call => call.start >= 160));
        assert.equal(result.subtitleTranslationProgress.completedCues, 80);
        assert.notEqual(result.subtitleTranslationProgress.processingComplete, true); await f.drained();
    });
}

test('cancellation during normal format repair preserves the last reviewed checkpoint and never visits the next batch', async t => {
    let damaged = false;
    const f = await fixture(t, (call, state) => {
        if (call.start !== 80 || call.review) return;
        if (!damaged) { damaged = true; return invalid['term shape'](call); }
        state.controller.abort();
    });
    await assert.rejects(f.run(), { name: 'AbortError' });
    assert.equal(f.record.subtitleTranslationProgress.completedCues, 80);
    assert(!f.calls.some(call => call.start >= 160)); await f.drained();
});

const summary = () => ({ summary: '합성 열차 안내입니다.', plot: '열차가 도착하고 안내를 확인합니다.', dialogueSummary: '도착 시각과 목적지를 안내합니다.',
    frames: [], labels: ['열차', '안내'], limitations: ['합성 검사 자료입니다.'] });

test('a parsed invalid summary repairs once and then translates valid source without replacing the saved summary', async t => {
    const f = await fixture(t, call => call.summary ? { ...summary(), labels: {} } : undefined, { full: true });
    const result = await f.run(); assert.equal(result.status, 'partial');
    assert.equal(result.summary, '합성 열차 안내'); assert.match(result.summaryError, /필수 항목이나 형식/);
    assert.equal(result.analysisDiagnostic.code, 'SUMMARY_INVALID');
    assert.equal(result.subtitleError, null); assert.equal(result.subtitleLanguage, 'ko');
    assert.equal(result.subtitleTranslation.length, 161);
    assert.equal(f.calls.filter(call => call.summary).length, 2);
    assert(f.calls.some(call => call.review && call.start === 160)); await f.drained();
});

test('a parsed invalid summary can be corrected by its single normal validation repair', async t => {
    let summaries = 0;
    const f = await fixture(t, call => call.summary ? ++summaries === 1 ? { ...summary(), frames: null } : summary() : undefined, { full: true });
    const result = await f.run(); assert.equal(result.summaryError, null); assert.equal(result.error, null);
    assert.equal(result.summary, summary().summary); assert.equal(result.subtitleTranslation.length, 161);
    assert.equal(summaries, 2); await f.drained();
});

test('a previously rejected summary diagnostic cannot survive a new successful summary attempt', async t => {
    let bad = true;
    const f = await fixture(t, call => call.summary ? bad ? { ...summary(), labels: {} } : summary() : undefined, { full: true });
    const first = await f.run(); assert.equal(first.analysisDiagnostic.code, 'SUMMARY_INVALID');
    bad = false;
    const result = await f.run(); assert.equal(result.summaryError, null); assert.equal(result.error, null);
    assert.equal(result.analysisDiagnostic, undefined); await f.drained();
});

test('parsed chunk summary validation cannot block the translation of valid time-aligned source', async t => {
    const f = await fixture(t, call => call.summary ? { summary: '합성 안내', dialogue: '합성 열차 안내', events: [42] } : undefined,
        { full: true, count: 801 });
    const result = await f.run(); assert.equal(result.summaryError, 'Codex 구간 요약 형식이 올바르지 않습니다.');
    assert.equal(result.analysisDiagnostic.code, 'SUMMARY_INVALID');
    assert.equal(result.subtitleLanguage, 'ko'); assert.equal(result.subtitleTranslation.length, 801);
    assert(f.calls.some(call => call.review && call.indexes.at(-1) === 800));
    assert(f.calls.filter(call => call.summary).length <= 4, 'only the two started chunks and their one normal repair may run');
    await f.drained();
});

for (const [name, fail] of Object.entries(hardStops)) test(`a summary ${name} cannot trigger validation recovery or subtitle continuation`, async t => {
    const f = await fixture(t, call => call.summary ? fail({ ...call, start: 0 }) : undefined, { full: true });
    const result = await f.run(); assert.equal(result.status, 'partial');
    assert(result.summaryError); assert.equal(f.calls.length, 1);
    assert.equal(result.subtitleTranslation, undefined); await f.drained();
});

for (const [name, fail] of Object.entries(hardStops)) test(`a summary ${name} during its one local repair still stops before subtitle translation`, async t => {
    let initial = true;
    const f = await fixture(t, call => {
        assert(call.summary, 'no subtitle provider request may start after a hard summary failure');
        if (initial) { initial = false; return { ...summary(), labels: null }; }
        return fail({ ...call, start: 0 });
    }, { full: true });
    const result = await f.run(); assert.equal(result.status, 'partial');
    assert(result.summaryError); assert.equal(f.calls.length, 2);
    assert.equal(result.subtitleTranslation, undefined); await f.drained();
});

const compactProviderEnvelopes = [
    ['HTTP 403', { status: 403 }, 'PROVIDER_AUTH'],
    ['HTTP 429', { statusCode: 429 }, 'PROVIDER_QUOTA'],
    ['HTTP 503', { httpStatus: 503 }, 'PROVIDER_UNAVAILABLE'],
    ['typed auth error', { error: { code: 'PROVIDER_AUTH', message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_AUTH'],
    ['typed quota cause', { cause: { code: 'PROVIDER_QUOTA', message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_QUOTA'],
    ['typed refusal error', { error: { code: 'PROVIDER_REFUSAL', message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_REFUSAL'],
    ['typed unavailable error', { error: { code: 'PROVIDER_UNAVAILABLE', message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_UNAVAILABLE'],
    ['typed auth cause HTTP', { cause: { code: 'PROVIDER_UNKNOWN', status: 403 } }, 'PROVIDER_AUTH'],
    ['HTTP-only immediate error', { error: { statusCode: 429, message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_QUOTA'],
    ['HTTP-only immediate cause', { cause: { httpStatus: 503, message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_UNAVAILABLE'],
    ['provider refusal type', { providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'],
    ['immediate provider type', { error: { providerErrorType: 'authentication' } }, 'PROVIDER_AUTH'],
    ['misleading local code', { code: 'SUBTITLE_BATCH_INVALID', httpStatus: 403 }, 'PROVIDER_AUTH'],
    ['unknown error', { error: { code: 'UNRECOGNIZED', message: 'PRIVATE_PROVIDER_MESSAGE' } }, 'PROVIDER_UNKNOWN'],
    ['misleading untyped message', { message: 'PRIVATE_PROVIDER_MESSAGE 401 refusal quota' }, 'PROVIDER_UNKNOWN'],
    ['structured refusal', { refusal: true }, 'SUBTITLE_PROVIDER_REFUSAL']
];
for (const [name, envelope, code] of compactProviderEnvelopes) test(`a raw compact review ${name} cannot be downgraded to local format recovery`, async t => {
    const f = await fixture(t, call => call.review ? { ...normal(call), ...envelope } : undefined);
    const result = await f.run();
    assert.equal(result.subtitleRepairStatus, 'failed'); assert.equal(result.subtitleDiagnostic.code, code);
    assert.equal(f.calls.filter(call => call.review).length, 1, 'no format repair or next batch may follow the service envelope');
    assert.equal(f.calls.length, 2); assert(!f.calls.some(call => call.start >= 80));
    assert.equal(result.subtitleTranslationPartial?.length || 0, 0);
    assert.notEqual(result.subtitleTranslationProgress.processingComplete, true);
    if (envelope.refusal) assert.equal(result.subtitleDiagnostic.refusalSource, 'response-field');
    assert.equal(JSON.stringify([result.subtitleDiagnostic, f.events]).includes('PRIVATE_PROVIDER_MESSAGE'), false);
    await f.drained();
});
