const test = require('node:test');
const assert = require('node:assert/strict');
const { ApprovedCueIndex } = require('../lib/approved-cue-index');

const sorted = map => [...map].sort((first, second) => first[0] - second[0]);
const previous = (map, before) => sorted(map).filter(([index]) => index < before).slice(-8)
    .map(([index, cue]) => ({ index, text: cue.text }));

function random(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

test('approved numeric source order and strict preceding context match Map with sparse and repeated insertions', () => {
    const cues = [90, -0, 74, 5, 28, 6, 16, 93, 11, 44, 66, 19, 44].map((index, offset) =>
        [index, Object.freeze({ text: `owned neutral translation ${offset}`, id: `cue-${index}`, start: index, end: index + 0.5 })]);
    const legacy = new Map(cues), current = new ApprovedCueIndex(cues);
    assert.deepEqual([...current], [...legacy], 'Map iteration retains insertion order');
    assert.equal(current.size, legacy.size);
    assert.deepEqual(current.orderedEntries(), sorted(legacy));
    for (const bound of [-Infinity, -1, 0, 5, 5.5, 19, 44, 74, 90, 94, Infinity, NaN, undefined]) {
        assert.deepEqual(current.previousTranslations(bound), previous(legacy, bound));
    }
    assert.strictEqual(current.get(44), cues.at(-1)[1]);
});

test('returned snapshots cannot mutate the index or change the original cue objects', () => {
    const source = Object.freeze(Array.from({ length: 20 }, (_, index) =>
        Object.freeze([index * 2, Object.freeze({ id: `cue-${index}`, text: `owned cue ${index}` })])));
    const current = new ApprovedCueIndex(source);
    const snapshot = current.orderedEntries();
    assert.strictEqual(snapshot[0][1], source[0][1]);
    snapshot[0][0] = 999;
    snapshot[1][1] = { text: 'altered snapshot only' };
    snapshot.reverse();
    const context = current.previousTranslations(40);
    context[0].text = 'altered context only';
    context.pop();
    assert.deepEqual(current.orderedEntries(), source);
    assert.deepEqual(current.previousTranslations(40), previous(new Map(source), 40));
    assert.equal(source[0][0], 0);
    assert.equal(source[0][1].text, 'owned cue 0');
});

test('deleting, replacing and clearing keep lookup, size and insertion iteration consistent', () => {
    const current = new ApprovedCueIndex([[8, { text: 'eight' }], [2, { text: 'two' }], [4, { text: 'four' }]]);
    const legacy = new Map(current);
    for (const index of [4, 7, 8, 2]) {
        assert.equal(current.delete(index), legacy.delete(index));
        assert.deepEqual(current.orderedEntries(), sorted(legacy));
        assert.deepEqual(current.previousTranslations(100), previous(legacy, 100));
    }
    assert.strictEqual(current.set(100, { text: 'one hundred' }), current);
    current.clear();
    assert.equal(current.size, 0);
    assert.deepEqual(current.orderedEntries(), []);
    assert.deepEqual(current.previousTranslations(0), []);
    current.set(3, { text: 'three' }); current.set(1, { text: 'one' });
    assert.deepEqual(current.orderedEntries().map(([index]) => index), [1, 3]);
    for (const invalid of [-1, NaN, Infinity, '1', undefined, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => current.set(invalid, { text: 'invalid' }), TypeError);
    }
});

test('randomized append, sparse correction, duplicate, delete and predecessor operations match the baseline', () => {
    const next = random(0x1942c0de);
    for (let scenario = 0; scenario < 160; scenario++) {
        const legacy = new Map(), current = new ApprovedCueIndex();
        for (let step = 0; step < 400; step++) {
            const index = Math.floor(next() * 900);
            if (next() < 0.16) assert.equal(current.delete(index), legacy.delete(index));
            else {
                const cue = Object.freeze({ id: `owned-${scenario}-${index}`, text: `neutral ${step}` });
                legacy.set(index, cue); current.set(index, cue);
            }
            const before = next() < 0.2 ? index : next() * 950;
            assert.deepEqual(current.previousTranslations(before), previous(legacy, before));
            if (step % 47 === 0) {
                assert.equal(current.size, legacy.size);
                assert.deepEqual([...current], [...legacy]);
                assert.deepEqual(current.orderedEntries(), sorted(legacy));
            }
        }
        assert.deepEqual(current.orderedEntries(), sorted(legacy));
    }
});
