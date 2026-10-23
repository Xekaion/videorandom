const test = require('node:test');
const assert = require('node:assert/strict');
const { expandSubtitleReview, reviewShapeIssues } = require('../lib/subtitle-review');

const requested = [{ index: 80 }, { index: 81 }, { index: 82 }];
const drafts = requested.map(({ index }) => ({ index, text: `합성 안내 ${index}번입니다.` }));
const options = { allowInvalidRows: true };
const expand = (result, entries = requested, input = drafts) => expandSubtitleReview(result, entries, input, options);
const response = () => ({ approvedIndexes: [80], corrections: [{ index: 81, text: '검수한 합성 안내입니다.' },
    { index: 82, text: '마지막 합성 안내입니다.' }], terms: [] });
const invalid = operation => assert.throws(operation, { code: 'SUBTITLE_BATCH_INVALID' });

test('opt-in compact review retains valid cues on both sides of a malformed correction', () => {
    const result = response();
    result.corrections[0].text = ' ';
    const expanded = expand(result);
    assert.deepEqual(expanded, { subtitles: [drafts[0], result.corrections[1]], terms: [] });
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [81], unassignedRows: 0 });
    assert.deepEqual(Object.keys(expanded), ['subtitles', 'terms']);
});

for (const [name, replacement] of [
    ['missing text', { index: 81 }],
    ['blank text', { index: 81, text: ' \n ' }],
    ['numeric text', { index: 81, text: 123 }],
    ['null text', { index: 81, text: null }],
    ['oversized text', { index: 81, text: '합'.repeat(10001) }],
    ['extra row field', { index: 81, text: '합성', explanation: '합성' }]
]) test(`opt-in compact review quarantines a known cue with ${name}`, () => {
    const result = response();
    result.corrections[0] = replacement;
    const expanded = expand(result);
    assert.deepEqual(expanded.subtitles.map(cue => cue.index), [80, 82]);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [81], unassignedRows: 0 });
});

test('malformed or unknown IDs are counted without coercion, inference or leaking raw rows', () => {
    const result = {
        approvedIndexes: [80, '81', null, 80.5, -1, 999, { index: 81 }],
        corrections: [null, 81, { text: '원시 응답 표본' }, { index: '81', text: '원시 응답 표본' },
            { index: 81.1, text: '원시 응답 표본' }, { index: 999, text: '원시 응답 표본' },
            { index: 82, text: '끝부분은 보관합니다.' }], terms: []
    };
    const expanded = expand(result);
    assert.deepEqual(expanded.subtitles, [drafts[0], { index: 82, text: '끝부분은 보관합니다.' }]);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [], unassignedRows: 12 });
    assert.equal(JSON.stringify(reviewShapeIssues(expanded)).includes('원시 응답'), false);
    assert.equal(JSON.stringify(reviewShapeIssues(expanded)).includes('999'), false);
});

for (const [name, change] of [
    ['identical approvals', result => { result.approvedIndexes.push(80); }],
    ['identical corrections', result => { result.approvedIndexes = []; result.corrections.push({ index: 80, text: '같은 대사' },
        { index: 80, text: '같은 대사' }); }],
    ['conflicting corrections', result => { result.corrections.push({ index: 80, text: '첫 수정' }, { index: 80, text: '다른 수정' }); }],
    ['approval and correction overlap', result => { result.corrections.push({ index: 80, text: '수정 대사' }); }],
    ['valid then malformed correction', result => { result.corrections.push({ index: 80, text: '' }); }],
    ['malformed then valid correction', result => { result.approvedIndexes = []; result.corrections.unshift({ index: 80 },
        { index: 80, text: '수정 대사' }); }]
]) test(`opt-in compact review drops every ambiguous occurrence for ${name}`, () => {
    const result = response();
    change(result);
    const expanded = expand(result);
    assert.deepEqual(expanded.subtitles.map(cue => cue.index), [81, 82]);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [80], unassignedRows: 0 });
});

test('surviving cues and invalid IDs follow the requested source order', () => {
    const entries = [{ index: 82 }, { index: 80 }, { index: 81 }, { index: 83 }];
    const input = [...drafts, { index: 83, text: '합성 마지막 안내' }];
    const result = { approvedIndexes: [83, 82, 81, 80, 82, 80], corrections: [], terms: [] };
    const expanded = expand(result, entries, input);
    assert.deepEqual(expanded.subtitles.map(cue => cue.index), [81, 83]);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [82, 80], unassignedRows: 0 });
});

test('excess malformed rows do not discard unique valid rows or auto-approve omitted cues', () => {
    const result = { approvedIndexes: Array(250).fill(999),
        corrections: [...Array.from({ length: 250 }, () => ({ index: 81, text: '반복 수정' })),
            { index: 82, text: '끝부분의 유일한 수정' }], terms: [] };
    const expanded = expand(result);
    assert.deepEqual(expanded.subtitles, [{ index: 82, text: '끝부분의 유일한 수정' }]);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [81], unassignedRows: 250 });
    const empty = expand({ approvedIndexes: [], corrections: [], terms: [] }, requested, undefined);
    assert.deepEqual(empty, { subtitles: [], terms: [] });
    assert.deepEqual(reviewShapeIssues(empty), { invalidIndexes: [], unassignedRows: 0 });
});

test('opt-in compact response has an absolute resource bound independent of requested cue count', () => {
    const result = { approvedIndexes: Array(49999).fill(999),
        corrections: [{ index: 82, text: '상한 안의 마지막 합성 안내' }], terms: [] };
    const expanded = expand(result);
    assert.deepEqual(expanded.subtitles, result.corrections);
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [], unassignedRows: 49999 });
    result.approvedIndexes.push(999);
    invalid(() => expand(result));
});

test('shape metadata is bound to adapter output identity and returned as a fresh copy', () => {
    const result = response(); result.corrections[0].text = '';
    const original = structuredClone({ result, requested, drafts });
    const expanded = expand(result);
    const first = reviewShapeIssues(expanded);
    first.invalidIndexes.push(999); first.unassignedRows = 123;
    assert.deepEqual(reviewShapeIssues(expanded), { invalidIndexes: [81], unassignedRows: 0 });
    assert.deepEqual({ result, requested, drafts }, original);
    assert.equal(reviewShapeIssues(result), undefined);
    assert.equal(reviewShapeIssues(structuredClone(expanded)), undefined);
    assert.equal(reviewShapeIssues({ subtitles: [], terms: [], invalidIndexes: [80], unassignedRows: 2 }), undefined);
    assert.equal(reviewShapeIssues(expandSubtitleReview(response(), requested, drafts)), undefined);
    for (const value of [null, undefined, false, 1, 'result']) assert.equal(reviewShapeIssues(value), undefined);
});

test('strict root shape and terms validation remains authoritative in opt-in mode', () => {
    for (const change of [
        result => { result.approvedIndexes = {}; }, result => { result.corrections = {}; },
        result => { result.terms = {}; }, result => { delete result.approvedIndexes; },
        result => { delete result.terms; }, result => { result.subtitles = []; },
        result => { result.terms = [{ source: '합성' }]; },
        result => { result.terms = [{ source: '합성', translation: 123 }]; },
        result => { result.terms = [{ source: '합성', translation: '합성', note: '추가' }]; },
        result => { result.terms = Array.from({ length: 101 }, () => ({ source: '합성', translation: '합성' })); }
    ]) {
        const result = response(); change(result);
        invalid(() => expand(result));
    }
});

test('requested index and internal draft integrity failures still reject in opt-in mode', () => {
    for (const entries of [[], null, [{ index: -1 }], [{ index: 80.1 }], [{ index: '80' }], [{ index: 80 }, { index: 80 }]]) {
        invalid(() => expand(response(), entries));
    }
    for (const input of [undefined, [], new Map(), new Map([[80, undefined]]), new Map([[80, ' ']]),
        new Map([[80, '합'.repeat(10001)]]), [...drafts, { ...drafts[0] }]]) {
        invalid(() => expandSubtitleReview(response(), requested, input, options));
    }
});

test('opt-in preserves refusal evidence and legacy responses for existing validators', () => {
    for (const result of [{ refusal: '합성 거절', approvedIndexes: [999], corrections: null, terms: {} },
        { subtitles: drafts, terms: [] }, { subtitles: [], terms: 'invalid' }, null, undefined, false]) {
        assert.equal(expand(result), result);
        assert.equal(reviewShapeIssues(result), undefined);
    }
    const result = { approvedIndexes: [], corrections: [{ index: 80, text: '이 요청의 번역을 제공할 수 없습니다.' }], terms: [] };
    assert.equal(expand(result).subtitles[0].text, result.corrections[0].text);
});
