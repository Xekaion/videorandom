const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { catalogRecord, subtitleMetadata } = require('../lib/catalog-record');
const { recordHealth } = require('../lib/record-health');

const source = Array.from({ length: 6 }, (_, index) => ({ id: `owned-${index}`, start: index * 10 + .125,
    end: index * 10 + 3.375, text: `合成の列車案内 ${index + 1}` }));
const fingerprint = cues => crypto.createHash('sha256').update(JSON.stringify(cues.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
const early = '2026-10-19T01:00:00.000Z', later = '2026-10-19T02:00:00.000Z';
const key = value => value.replace(/\//g, '\\').toLowerCase();

function full(count, changes = {}) {
    const transcript = structuredClone(changes.transcript || source);
    const result = { id: 'owned-record', name: 'owned-train.mp4', path: 'Z:/owned-train.mp4', status: 'completed', summary: '보관된 합성 안내',
        plot: '같은 원문을 사용한 합성 줄거리', frames: [], labels: [], warnings: [], savedAt: early, analyzedAt: early,
        transcript, subtitleTranslationPartial: transcript.slice(0, count).map(cue => ({ ...cue, text: '검증된 합성 번역' })),
        subtitleTranslationProgress: { version: 1, language: 'ko', sourceFingerprint: fingerprint(transcript),
            totalCues: transcript.length, completedCues: count, complete: false, sourceComplete: true, translationComplete: false }, ...changes };
    Object.assign(result, subtitleMetadata(result)); result.health = recordHealth(result);
    return result;
}

function harness() {
    const filename = path.join(__dirname, '..', 'public', 'js', 'catalog.js');
    const original = fs.readFileSync(filename, 'utf8');
    const marker = '  window.videoCatalog = { onScan, onPick };';
    assert(original.includes(marker));
    const instrumented = original.replace(marker,
        '  window.__catalogCountMerge = { state, mergeRecords, fileActivity };\n' + marker);
    const sandbox = { document: { addEventListener() {} }, videoCatalogSort: require('../public/js/catalog-sort'), console, URL };
    sandbox.window = sandbox;
    vm.runInNewContext(instrumented, sandbox, { filename });
    const api = sandbox.__catalogCountMerge;
    const stored = () => api.state.records.get(key('Z:/owned-train.mp4'));
    const merge = records => api.mergeRecords(records);
    const activity = (current, attempt, jobChanges = {}) => {
        api.state.records.set(key(current.path), current);
        api.state.job = { id: 'owned-job', status: 'completed', source: 'manual', results: [attempt], ...jobChanges };
        api.state.jobTargets = { id: 'owned-job', keys: new Set([key(current.path)]) };
        return api.fileActivity(current);
    };
    return { ...api, merge, stored, activity };
}

test('a stale same-ID compact job cannot reduce an equal-time validated subtitle count', () => {
    const h = harness(), current = catalogRecord(full(5)), stale = catalogRecord(full(2));
    h.merge([current]); h.merge([stale]);
    assert.equal(h.stored(), current); assert.equal(h.stored().subtitleTranslatedCount, 5);
});

test('a stale same-ID full job cannot replace a fresher compact count at the same timestamp', () => {
    const h = harness(), current = catalogRecord(full(5)), stale = full(2);
    h.merge([current]); h.merge([stale]);
    assert.equal(h.stored(), current);
});

test('equal-time full-to-summary refresh applies a newly derived subtitle count instead of retaining stale detail', () => {
    const h = harness(), previous = full(2), latest = catalogRecord(full(5));
    h.merge([previous]); h.merge([latest]);
    assert.equal(h.stored().subtitleTranslatedCount, 5); assert.equal(h.stored(), latest);
});

test('equal-time full-to-summary refresh applies a changed health outcome even when subtitle count is unchanged', () => {
    const h = harness(), previous = full(2), latest = catalogRecord(full(2));
    latest.health = { ...latest.health, reason: '새로운 안전한 저장 실패 안내', completion: { ...latest.health.completion, subtitleSaveFailed: true } };
    h.merge([previous]); h.merge([latest]);
    assert.equal(h.stored().health.completion.subtitleSaveFailed, true);
    assert.equal(h.stored().transcript, previous.transcript, 'derived list health does not remove loaded dialogue');
});

test('an identical compact projection keeps already loaded full detail', () => {
    const h = harness(), previous = full(2), identical = catalogRecord(previous);
    h.merge([previous]); h.merge([identical]);
    assert.equal(h.stored().transcript, previous.transcript); assert.equal(h.stored().transcript.length, 6);
    assert.equal(h.stored().catalogView, undefined);
});

test('newer ordinary partial analysis with more verified subtitles can replace an old completed record and survives late old-job polling', () => {
    const h = harness();
    const old = catalogRecord(full(2, { id: 'owned-old', status: 'completed' }));
    const next = catalogRecord(full(5, { id: 'owned-new', status: 'partial', savedAt: later, analyzedAt: later }));
    h.merge([old]); h.merge([next]); assert.equal(h.stored(), next);
    h.merge([old]); assert.equal(h.stored(), next, 'status completed must not erase newer validated subtitle progress');
});

test('a newer partial failure without any usable summary does not erase the prior usable summary', () => {
    const h = harness(), old = catalogRecord(full(2, { id: 'owned-old' }));
    const failure = catalogRecord(full(5, { id: 'owned-failure', status: 'partial', summary: '', plot: '', savedAt: later, analyzedAt: later }));
    h.merge([old]); h.merge([failure]); assert.equal(h.stored(), old);
});

test('a deliberate newer same-source edit may reduce a count and is not mistaken for a stale job', () => {
    const h = harness(), old = catalogRecord(full(5)), newer = catalogRecord(full(2, { savedAt: later, editedAt: later }));
    h.merge([old]); h.merge([newer]); assert.equal(h.stored(), newer);
});

test('changed source dialogue permits a same-ID count decrease even at an equal timestamp', () => {
    const h = harness(), old = catalogRecord(full(5));
    const changedSource = source.map((cue, index) => ({ ...cue, text: `different owned source ${index}` }));
    const changed = catalogRecord(full(2, { transcript: changedSource }));
    assert.notEqual(changed.subtitleTranslationSourceFingerprint, old.subtitleTranslationSourceFingerprint);
    h.merge([old]); h.merge([changed]); assert.equal(h.stored(), changed);
});

test('a different-source newer completed analysis may legitimately replace a larger old count', () => {
    const h = harness(), old = catalogRecord(full(5, { id: 'owned-old' }));
    const changedSource = source.map((cue, index) => ({ ...cue, text: `new owned material ${index}` }));
    const changed = catalogRecord(full(1, { id: 'owned-new-source', transcript: changedSource, savedAt: later, analyzedAt: later }));
    h.merge([old]); h.merge([changed]); assert.equal(h.stored(), changed);
});

test('unknown or unrelated fingerprints cannot use count preference to displace a prior completed summary', () => {
    for (const unknown of [true, false]) {
        const h = harness(), old = catalogRecord(full(2, { id: 'owned-old' }));
        const candidate = catalogRecord(full(5, { id: 'owned-new', status: 'partial', savedAt: later, analyzedAt: later }));
        if (unknown) delete candidate.subtitleTranslationSourceFingerprint;
        else candidate.subtitleTranslationSourceFingerprint = 'f'.repeat(64);
        h.merge([old]); h.merge([candidate]); assert.equal(h.stored(), old);
    }
});

test('an older terminal failure no longer overrides a newer representative record activity', () => {
    const h = harness(), current = catalogRecord(full(5, { id: 'owned-new', savedAt: later, analyzedAt: later }));
    const stale = catalogRecord(full(2, { id: 'owned-old', subtitleError: '과거 합성 오류', subtitleRepairStatus: 'failed' }));
    assert.equal(h.activity(current, stale), null);
});

test('a lower-count terminal failure is suppressed for the same exact source even when timestamps are equal', () => {
    const h = harness(), current = catalogRecord(full(5));
    const stale = catalogRecord(full(2, { subtitleError: '과거 합성 오류', subtitleRepairStatus: 'failed' }));
    assert.equal(h.activity(current, stale), null);
});

test('a current terminal failure stays visible when there is no newer or more complete exact-source result', () => {
    const h = harness(), current = catalogRecord(full(1, { id: 'owned-old' }));
    const attempt = catalogRecord(full(2, { id: 'owned-attempt', savedAt: later, analyzedAt: later,
        subtitleError: '현재 합성 번역 오류', subtitleRepairStatus: 'failed' }));
    const activity = h.activity(current, attempt);
    assert(activity); assert(activity.label.includes('복구 필요')); assert(activity.detail.includes('현재 합성 번역 오류'));
});

test('active job activity remains visible while a more complete old saved result exists', () => {
    const h = harness(), current = catalogRecord(full(5));
    const activity = h.activity(current, undefined, { status: 'running', currentFilePath: current.path, results: [], percent: 30, stage: '합성 작업' });
    assert.equal(activity.active, true); assert.equal(activity.percent, 30);
});
