const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { catalogRecord } = require('../lib/catalog-record');

// Neutral in-memory records exercise the actual catalog script. The only
// injection exposes its merge function/state to this test's isolated VM.
const fixtureFile = path.join(__dirname, 'completed-actions-ui-v1914.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8');
const nativeRequire = createRequire(fixtureFile);
const instrumentedFs = { ...fs, readFileSync(file, ...args) {
  const content = fs.readFileSync(file, ...args);
  return typeof content === 'string' && path.resolve(file) === path.resolve(__dirname, '../public/js/catalog.js')
    ? content.replace('  function renderStorage() {', '  window.ownedMergeRecords = mergeRecords; window.ownedCatalogState = state;\n  function renderStorage() {')
    : content;
} };
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest('))
  + '\nmodule.exports = { boot, result, rowFor, nodes, textOf, openDetail, settings };', {
  module: fixtureModule,
  require: name => name === 'node:fs' ? instrumentedFs : name === 'node:module'
    ? { ...nativeRequire(name), createRequire: location => {
      const scoped = nativeRequire(name).createRequire(location);
      return dependency => dependency === 'node:fs' ? instrumentedFs : scoped(dependency);
    } } : nativeRequire(name),
  __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, result, rowFor, nodes, openDetail, settings } = fixtureModule.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const oldAt = '2026-10-27T00:00:00.000Z', freshAt = '2026-10-27T01:00:00.000Z', translatedAt = '2026-10-27T02:00:00.000Z';
function records() {
  const old = { ...result('owned-old-100', { total: 100, completed: 100 }), savedAt: oldAt };
  const fresh = { ...result('owned-fresh-1200', { total: 1200, completed: 100, sourceReview: true }),
    path: old.path, name: old.name, sourceReanalysis: true, repairOf: old.id, savedAt: freshAt };
  const translated = { ...result('owned-translated-1200', { total: 1200, completed: 200, sourceReview: true }),
    path: old.path, name: old.name, operation: 'translation-only', repairOf: fresh.id,
    subtitleRepairStatus: 'partial', savedAt: translatedAt };
  return { old, fresh, translated };
}
function compact(record) {
  return { ...catalogRecord(record), ...(record.sourceReanalysis === true ? { sourceReanalysis: true } : {}) };
}
const selected = ui => [...ui.sandbox.ownedCatalogState.records.values()][0];
const rowButton = (ui, id, translation = false) => nodes(rowFor(ui, id)).find(node => node.tag === 'button'
  && (translation ? node.dataset.translationRepairId === id : node.dataset.repairRecordId === id));

for (const summary of [false, true]) for (const reverse of [false, true]) {
  test(`fresh 1200-cue partial replaces legacy 100-cue completion (${summary ? 'compact' : 'full'}, ${reverse ? 'reverse' : 'forward'})`, async () => {
    const { old, fresh } = records();
    const list = reverse ? [fresh, old] : [old, fresh];
    const ui = await boot({ records: summary ? list.map(compact) : list, savedSettings: settings });
    assert.equal(selected(ui).id, fresh.id);
    assert.equal(selected(ui).transcript?.length ?? selected(ui).transcriptCount, 1200);
    ui.sandbox.ownedMergeRecords([summary ? compact(old) : old]);
    assert.equal(selected(ui).id, fresh.id, 'a later old-only poll cannot restore the legacy result');
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  });
}

for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [0, 2, 1], [1, 2, 0], [2, 0, 1]]) {
  test(`translation following fresh ASR remains selected across lineage order ${order.join('-')}`, async () => {
    const { old, fresh, translated } = records();
    const list = [old, fresh, translated];
    const ui = await boot({ records: order.map(index => compact(list[index])), savedSettings: settings });
    assert.equal(selected(ui).id, translated.id);
    ui.sandbox.ownedMergeRecords([compact(old)]);
    assert.equal(selected(ui).id, translated.id);
    ui.sandbox.ownedMergeRecords([compact(fresh)]);
    assert.equal(selected(ui).id, translated.id);
  });
}

test('a translation received in a separate poll retains fresh-source ancestry without holding old dialogue', async () => {
  const { old, fresh, translated } = records();
  const ui = await boot({ records: [compact(old), compact(fresh)], savedSettings: settings });
  ui.sandbox.ownedMergeRecords([compact(translated)]);
  assert.equal(selected(ui).id, translated.id);
  ui.sandbox.ownedMergeRecords([compact(old)]);
  assert.equal(selected(ui).id, translated.id);
  for (const record of ui.sandbox.ownedCatalogState.recordLineage.values()) {
    assert.equal(record.transcript, undefined);
    assert.equal(record.subtitleTranslation, undefined);
    assert.equal(record.subtitleTranslationPartial, undefined);
  }
});

test('compact hydration retains the fresh source and loaded dialogue through refresh', async () => {
  const { old, fresh } = records();
  const full = { ...fresh, ...catalogRecord(fresh), ...fresh };
  delete full.catalogView;
  Object.assign(full, { subtitleTranslatedCount: 100,
    subtitleTranslationSourceFingerprint: fresh.subtitleTranslationProgress.sourceFingerprint });
  const ui = await boot({ records: [compact(old), compact(fresh)], savedSettings: settings });
  ui.sandbox.ownedMergeRecords([full]);
  assert.equal(selected(ui).id, fresh.id);
  assert.equal(selected(ui).transcript.length, 1200);
  ui.sandbox.ownedMergeRecords([compact(old), compact(fresh)]);
  assert.equal(selected(ui).id, fresh.id);
  assert.equal(selected(ui).transcript.length, 1200);
});

for (const reverse of [false, true]) for (const summary of [false, true]) {
  test(`zero-source failed reanalysis preserves usable old source (${reverse}, ${summary})`, async () => {
    const { old, fresh } = records();
    const failed = { ...fresh, status: 'failed', transcript: [], summary: '', subtitleTranslationPartial: [],
      subtitleTranslationProgress: undefined, error: 'Synthetic source recognition unavailable' };
    const list = reverse ? [failed, old] : [old, failed];
    const ui = await boot({ records: summary ? list.map(compact) : list, savedSettings: settings });
    assert.equal(selected(ui).id, old.id);
  });
}

for (const invalid of ['missing-marker', 'wrong-parent', 'wrong-path', 'older-time', 'malformed-cue', 'empty-count-proof']) {
  test(`fresh-source priority rejects ${invalid}`, async () => {
    const { old, fresh } = records();
    if (invalid === 'missing-marker') delete fresh.sourceReanalysis;
    if (invalid === 'wrong-parent') fresh.repairOf = 'owned-unrelated';
    if (invalid === 'wrong-path') fresh.path = 'Z:\\OWNED_UNRELATED\\other.mp4';
    if (invalid === 'older-time') fresh.savedAt = '2026-10-26T00:00:00.000Z';
    if (invalid === 'malformed-cue') fresh.transcript[100].end = fresh.transcript[100].start;
    const candidate = invalid === 'empty-count-proof'
      ? { ...compact(fresh), subtitleTranslationSourceFingerprint: undefined } : fresh;
    const ui = await boot({ records: [old, candidate], savedSettings: settings });
    assert.equal(ui.sandbox.ownedCatalogState.records.get(old.path.toLowerCase()).id, old.id);
  });
}

for (const queued of [false, true]) for (const translation of [false, true]) {
  test(`${queued ? 'queued' : 'immediate'} ${translation ? 'translation retains source' : 'reanalysis forces fresh ASR'} request`, async () => {
    const { old } = records();
    const other = result('owned-other-active');
    const active = { id: 'owned-active', source: 'manual', status: 'running', total: 1, completed: 0,
      currentFile: other.name, currentFilePath: other.path, stage: 'Synthetic active job', percent: 40, results: [] };
    const queue = { enabled: true, paused: false, configured: true, options: settings,
      pending: [], pendingCount: 0, currentBatch: [], activeJob: queued ? active : null };
    const ui = await boot({ records: [old, ...(queued ? [other] : [])], savedSettings: { ...settings, transcribeAudio: false },
      initialQueue: queue, initialActiveJob: queued ? active : null });
    const fetch = ui.sandbox.fetch;
    ui.sandbox.fetch = async (url, options = {}) => {
      if (url === '/api/analysis/queue/repair') {
        ui.calls.push({ url, method: options.method, body: JSON.parse(options.body) });
        return { ok: true, status: 202, json: async () => ({ status: 'queued', addedCount: 1, queue: plain(queue) }) };
      }
      return fetch(url, options);
    };
    assert.equal(ui.elements.get('catalogTranscribe').checked, false);
    const button = rowButton(ui, old.id, translation); assert(button);
    if (!translation) assert.match(button.textContent, /원문부터 다시 분석/);
    else assert.match(button.title, /원문 100구간.*원문 구간 수는 늘어나지/);
    await button.dispatch('click');
    const posts = ui.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, queued ? '/api/analysis/queue/repair'
      : `/api/analysis/results/${old.id}/${translation ? 'subtitles/repair' : 'repair'}`);
    assert.equal(posts[0].body.options.transcribeAudio, !translation);
    if (queued) assert.equal(posts[0].body.operation, translation ? 'translation-only' : 'analysis');
  });
}

test('detail additional actions distinguish fresh recognition from fixed-source translation', async () => {
  const { old } = records();
  const ui = await boot({ records: [old], savedSettings: { ...settings, transcribeAudio: false } });
  await openDetail(ui, old.id);
  assert.match(ui.elements.get('catalogDetailRepair').textContent, /원문부터 다시 분석/);
  assert.match(ui.elements.get('catalogSubtitleRepair').title, /원문 100구간.*원문 구간 수는 늘어나지/);
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  const post = ui.calls.find(call => call.method === 'POST');
  assert.equal(post.url, `/api/analysis/results/${old.id}/repair`);
  assert.equal(post.body.options.transcribeAudio, true);
});
