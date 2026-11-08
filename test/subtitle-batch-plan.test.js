const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subtitleBatchAt } = require('../lib/subtitle-batch-plan');

function source(length, text = '원문') {
    return Array.from({ length }, (_, index) => ({ id: `cue-${index}`, text }));
}

test('long transcripts proactively use 32 cue requests without changing the shorter job limit', () => {
    const pending = Array.from({ length: 100 }, (_, index) => index);
    assert.equal(subtitleBatchAt(source(959), pending, 0).length, 80);
    assert.equal(subtitleBatchAt(source(960), pending, 0).length, 32);
});

test('a two-hour recording still uses small requests when it has only 672 source cues', () => {
    const transcript = source(672);
    const pending = Array.from({ length: 100 }, (_, index) => 500 + index);
    assert.equal(subtitleBatchAt(transcript, pending, 0, 3599.9).length, 80);
    assert.equal(subtitleBatchAt(transcript, pending, 0, 3600).length, 32);
    assert.deepEqual(subtitleBatchAt(transcript, pending, 0, 7200).map(cue => cue.index), pending.slice(0, 32));
    assert.equal(subtitleBatchAt(transcript, pending, 0, Infinity).length, 80);
});

test('the text cap splits requests before the cue count limit, without truncating source text', () => {
    const pending = [7, 16, 29, 55, 79, 104, 220, 701];
    const text = 'あ'.repeat(1600);
    assert.deepEqual(subtitleBatchAt(source(959, text), pending, 0).map(cue => cue.index), pending.slice(0, 7));
    const long = source(960, text);
    const batch = subtitleBatchAt(long, pending, 0);
    assert.deepEqual(batch, pending.slice(0, 3).map(index => ({ index, text, id: `cue-${index}` })));
    assert.deepEqual(subtitleBatchAt(long, pending, batch.length).map(cue => cue.index), [55, 79, 104]);
});

test('sparse resume and lookahead preserve exact original cue indexes and IDs', () => {
    const transcript = source(960);
    const pending = Array.from({ length: 39 }, (_, index) => 2 + index * 13);
    delete transcript[pending[0]].id;
    const first = subtitleBatchAt(transcript, pending, 0);
    const next = subtitleBatchAt(transcript, pending, first.length);
    assert.equal(first.length, 32);
    assert.deepEqual(first[0], { index: pending[0], text: '원문' });
    assert.deepEqual(next, subtitleBatchAt(transcript, pending, 32));
    assert.deepEqual([...first, ...next].map(cue => cue.index), pending);
    assert.equal(next.at(-1).id, `cue-${pending.at(-1)}`);
    assert.deepEqual(subtitleBatchAt(transcript, pending, pending.length), []);
});

test('a single cue over the text cap remains intact and traversal can advance', () => {
    for (const length of [50, 960]) {
        const transcript = source(length);
        transcript[4].text = '하'.repeat(12001);
        const pending = [4, 22];
        const first = subtitleBatchAt(transcript, pending, 0);
        assert.deepEqual(first, [{ index: 4, ...transcript[4] }]);
        assert.deepEqual(subtitleBatchAt(transcript, pending, first.length), [{ index: 22, ...transcript[22] }]);
    }
});
