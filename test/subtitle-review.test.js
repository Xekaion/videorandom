const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSubtitleReviewSchema, expandSubtitleReview } = require('../lib/subtitle-review');

const requested = [{ index: 80 }, { index: 81 }, { index: 82 }];
const drafts = [{ index: 80, text: '합성 열차가 도착합니다.' }, { index: 81, text: '승강장 안쪽에서 기다리세요.' },
    { index: 82, text: '출발 시간을 확인하세요.' }];
const delta = () => ({ approvedIndexes: [82, 80], corrections: [{ index: 81, text: '안전선 안쪽에서 기다리세요.' }],
    terms: [{ source: '合成駅', translation: '합성역' }] });
const invalid = operation => assert.throws(operation, { code: 'SUBTITLE_BATCH_INVALID' });

test('review schema bounds approvals, corrections and terms to the requested indexes', () => {
    const schema = buildSubtitleReviewSchema(requested);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['approvedIndexes', 'corrections', 'terms']);
    assert.deepEqual(schema.properties.approvedIndexes.items.enum, [80, 81, 82]);
    assert.deepEqual(schema.properties.corrections.items.properties.index.enum, [80, 81, 82]);
    assert.equal(schema.properties.approvedIndexes.maxItems, 3);
    assert.equal(schema.properties.corrections.maxItems, 3);
    assert.equal(schema.properties.corrections.items.additionalProperties, false);
    assert.equal(schema.properties.terms.items.additionalProperties, false);
    assert.equal(schema.properties.terms.maxItems, 100);
    assert.deepEqual(schema.properties.terms.items.required, ['source', 'translation']);
});

test('complete delta expands only explicit approvals and corrections in source order without mutation', () => {
    const result = delta();
    const original = structuredClone({ result, requested, drafts });
    assert.deepEqual(expandSubtitleReview(result, requested, drafts), {
        subtitles: [{ index: 80, text: drafts[0].text }, result.corrections[0], { index: 82, text: drafts[2].text }], terms: result.terms
    });
    assert.deepEqual({ result, requested, drafts }, original);
    assert.deepEqual(expandSubtitleReview(result, requested, new Map(drafts.map(cue => [cue.index, cue.text]))),
        expandSubtitleReview(result, requested, drafts));
});

test('partial review leaves every omitted index absent instead of auto-approving its draft', () => {
    const result = { approvedIndexes: [82], corrections: [{ index: 80, text: '검수한 앞부분입니다.' }], terms: [] };
    assert.deepEqual(expandSubtitleReview(result, requested, drafts), {
        subtitles: [{ index: 80, text: '검수한 앞부분입니다.' }, { index: 82, text: drafts[2].text }], terms: []
    });
    assert.deepEqual(expandSubtitleReview({ approvedIndexes: [], corrections: [], terms: [] }, requested, undefined),
        { subtitles: [], terms: [] });
});

test('a targeted request cannot return another cue from the same larger draft batch', () => {
    assert.deepEqual(expandSubtitleReview({ approvedIndexes: [81], corrections: [], terms: [] }, [requested[1]], drafts),
        { subtitles: [{ index: 81, text: drafts[1].text }], terms: [] });
    invalid(() => expandSubtitleReview({ approvedIndexes: [80], corrections: [], terms: [] }, [requested[1]], drafts));
});

test('approved short or non-Korean drafts stay unchanged for the existing strict final validator', () => {
    for (const text of ['네.', '合成の原文だけです。']) {
        const result = expandSubtitleReview({ approvedIndexes: [80], corrections: [], terms: [] }, [requested[0]], new Map([[80, text]]));
        assert.equal(result.subtitles[0].text, text, 'the adapter cannot pad or fabricate a translation');
    }
});

test('legacy full responses and their malformed shapes pass unchanged to the established validator', () => {
    for (const result of [{ subtitles: drafts, terms: [] }, { subtitles: [], terms: 'bad' }, { refusal: true }, null, undefined, false]) {
        assert.equal(expandSubtitleReview(result, requested, drafts), result);
    }
});

test('explicit provider refusal evidence survives sparse malformed fields before shape validation', () => {
    for (const refusal of [true, '서비스에서 요청을 거절했습니다.', { reason: 'owned synthetic refusal' }]) {
        const result = { refusal, approvedIndexes: [999], corrections: null, terms: 'bad' };
        assert.equal(expandSubtitleReview(result, requested, drafts), result);
        assert.equal(result.refusal, refusal);
    }
});

test('refusal text in corrections or approved drafts is preserved for the established refusal detector', () => {
    const text = '이 요청의 번역을 제공할 수 없습니다.';
    assert.equal(expandSubtitleReview({ approvedIndexes: [], corrections: [{ index: 80, text }], terms: [] }, requested, drafts)
        .subtitles[0].text, text);
    assert.equal(expandSubtitleReview({ approvedIndexes: [80], corrections: [], terms: [] }, requested, new Map([[80, text]]))
        .subtitles[0].text, text);
});

for (const [name, change] of [
    ['duplicate approvals', result => { result.approvedIndexes = [80, 80]; }],
    ['duplicate corrections', result => { result.corrections.push({ ...result.corrections[0] }); }],
    ['approval and correction overlap', result => { result.approvedIndexes.push(81); }],
    ['foreign approval index', result => { result.approvedIndexes[0] = 999; }],
    ['foreign correction index', result => { result.corrections[0].index = 999; }],
    ['fractional approval index', result => { result.approvedIndexes[0] = 80.5; }],
    ['string correction index', result => { result.corrections[0].index = '81'; }],
    ['too many approvals', result => { result.approvedIndexes = [80, 81, 82, 83]; }],
    ['too many corrections', result => { result.corrections = Array.from({ length: 4 }, () => ({ index: 81, text: '합성' })); }],
    ['missing approval array', result => { delete result.approvedIndexes; }],
    ['missing correction array', result => { delete result.corrections; }],
    ['missing terms', result => { delete result.terms; }],
    ['non-array approvals', result => { result.approvedIndexes = {}; }],
    ['non-array corrections', result => { result.corrections = {}; }],
    ['non-array terms', result => { result.terms = {}; }],
    ['extra top-level field', result => { result.summary = '합성'; }],
    ['legacy and sparse mixed response', result => { result.subtitles = drafts; }],
    ['extra correction field', result => { result.corrections[0].explanation = '합성'; }],
    ['missing correction text', result => { delete result.corrections[0].text; }],
    ['blank correction text', result => { result.corrections[0].text = ' \n '; }],
    ['non-string correction text', result => { result.corrections[0].text = 123; }],
    ['oversized correction text', result => { result.corrections[0].text = '합'.repeat(10001); }],
    ['extra term field', result => { result.terms[0].note = '합성'; }],
    ['missing term source', result => { delete result.terms[0].source; }],
    ['non-string term translation', result => { result.terms[0].translation = 123; }],
    ['too many terms', result => { result.terms = Array.from({ length: 101 }, () => ({ source: '合成', translation: '합성' })); }]
]) test(`malformed sparse review rejects ${name}`, () => {
    const result = delta(); change(result);
    invalid(() => expandSubtitleReview(result, requested, drafts));
});

test('approvals require a real nonempty bounded draft and never fall back to source text', () => {
    const result = { approvedIndexes: [80], corrections: [], terms: [] };
    for (const input of [undefined, [], new Map(), new Map([[80, undefined]]), new Map([[80, ' ']]),
        new Map([[80, '합'.repeat(10001)]]), [...drafts, { ...drafts[0] }]]) {
        invalid(() => expandSubtitleReview(result, requested, input));
    }
});

test('invalid requested index lists cannot construct a schema or interpret sparse results', () => {
    for (const entries of [[], null, [{ index: -1 }], [{ index: 0.1 }], [{ index: '80' }], [{ index: 80 }, { index: 80 }]]) {
        invalid(() => buildSubtitleReviewSchema(entries));
        invalid(() => expandSubtitleReview({ approvedIndexes: [], corrections: [], terms: [] }, entries, drafts));
    }
});

test('synthetic 80-cue review reduces repeated response bytes while retaining identical expanded subtitles', t => {
    const text = '합성 열차가 도착합니다. 안전을 위해 승강장 안쪽에서 기다리고 안내와 출발 시간을 확인하세요.';
    const cues = Array.from({ length: 80 }, (_, index) => ({ index, text }));
    const full = { subtitles: cues, terms: [] };
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const measurements = [];
    for (const correctedCues of [0, 1, 8, 40, 80]) {
        const result = { approvedIndexes: cues.slice(correctedCues).map(cue => cue.index), corrections: cues.slice(0, correctedCues), terms: [] };
        const responseBytes = Buffer.byteLength(JSON.stringify(result));
        assert.deepEqual(expandSubtitleReview(result, cues, cues), full);
        if (correctedCues <= 8) assert(responseBytes < fullBytes * 0.13);
        measurements.push({ correctedCues, fullBytes, responseBytes,
            reductionPercent: +((1 - responseBytes / fullBytes) * 100).toFixed(2) });
    }
    t.diagnostic(JSON.stringify({ syntheticResponseBytesOnly: true, actualProviderOrLatencyMeasured: false, measurements }));
});
