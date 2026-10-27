const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { catalogRecord } = require('../lib/catalog-record');
const { recordHealth } = require('../lib/record-health');

// All records and requests below belong to this in-memory UI fixture. No real
// media, local analysis server, provider or browser is used by these tests.
const fixtureFile = path.join(__dirname, 'auto-pick-ui.test.js');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const fixtureEnd = fixtureSource.indexOf('\ntest(');
assert(fixtureEnd > 0);
let declarations = fixtureSource.slice(0, fixtureEnd);
assert(declarations.includes('setAttribute() {}'));
declarations = declarations.replace('setAttribute() {}', 'setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }');
const fixtureModule = { exports: {} };
vm.runInNewContext(declarations + '\nmodule.exports = { boot };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot } = fixtureModule.exports;
const publicDir = path.join(__dirname, '..', 'public');
const settings = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko', transcriptLanguage: 'ja', frameCount: 10 };
const flush = () => new Promise(setImmediate);
const nodes = root => root ? [root, ...(root.childNodes || []).flatMap(nodes)] : [];
const textOf = root => nodes(root).map(node => node.textContent || '').join(' ');
const hasClass = (node, name) => (node?.className || '').split(/\s+/).includes(name) || node?.classList?.contains(name);
const hidden = node => !node || node.hidden === true || hasClass(node, 'hidden');
const rowFor = (ui, id) => ui.elements.get('catalogRows').childNodes.find(row => row.childNodes[1]?.childNodes[0]?.dataset?.recordId === id);
const posts = ui => ui.calls.filter(call => call.method === 'POST');
const namedButton = (root, pattern) => nodes(root).find(node => node.tag === 'button' && pattern.test(node.textContent));
const moreActions = root => nodes(root).find(node => node.tag === 'details' && nodes(node).some(child => child.tag === 'summary' && /추가 작업/.test(child.textContent)));
const visibleButtons = root => {
  const buttons = [];
  const visit = node => {
    if (hidden(node)) return;
    if (node.tag === 'button') buttons.push(node);
    if (node.tag === 'details' && !node.open) return;
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  return buttons;
};

function result(id, { completed = 4, total = 4, summary = true, sourceReview = false, saveFailed = false, unchecked = false } = {}) {
  const transcript = Array.from({ length: total }, (_, index) => ({ id: `owned-${index}`, start: index * 5 + 0.5,
    end: index * 5 + 4.5, text: '合成の列車の案内です。' }));
  const translation = transcript.slice(0, completed).map(cue => ({ ...cue, text: '합성 열차 안내입니다.' }));
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
  const translationComplete = completed === total && !unchecked;
  const complete = translationComplete && !sourceReview;
  const record = { id, path: `Z:\\OWNED_ACTION_UI_ONLY\\${id}.mp4`, name: `${id}.mp4`, ext: 'MP4',
    status: complete && summary && !saveFailed ? 'completed' : 'partial', analysisMode: 'codex',
    summary: summary ? '합성 열차의 안내 방송입니다.' : '', plot: '', dialogueSummary: '합성 안내 방송', labels: [], frames: [],
    duration: total * 5 + 1, transcriptSource: 'sidecar:owned-synthetic.srt', transcriptLanguage: 'ja', transcript,
    ...(complete ? { subtitleLanguage: 'ko', subtitleTranslation: translation } : { subtitleTranslationPartial: translation }),
    subtitleTranslationProgress: { version: 1, language: 'ko', sourceFingerprint, totalCues: total, completedCues: completed,
      complete, translationComplete, sourceComplete: !sourceReview, sourceProcessed: true, sourceAuditComplete: !sourceReview },
    ...(saveFailed ? { subtitleAutoSave: { status: 'failed', error: '합성 자막 파일 쓰기 실패' } } : {}),
    warnings: [] };
  record.health = recordHealth(record);
  return record;
}

async function openDetail(ui, id) {
  const row = rowFor(ui, id); assert(row);
  await row.childNodes[1].childNodes[0].dispatch('click');
}

function assertNoDefaultRepair(row) {
  assert(!visibleButtons(row).some(button => /복구|다시 분석|다시 번역/.test(button.textContent)),
    'finished work does not present repair or replacement as a primary action');
}

test('detail replacement controls live inside a closed explicit additional-actions disclosure', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const details = html.match(/<details\b[^>]*\bid="catalogDetailExtraActions"[^>]*>([\s\S]*?)<\/details>/);
  assert(details, 'the actual detail HTML contains the additional-actions disclosure');
  assert.doesNotMatch(details[0].slice(0, details[0].indexOf('>')), /\sopen(?:\s|=|>)/);
  assert.match(details[1], /<summary[^>]*>[^<]*추가 작업/);
  assert.match(details[1], /id="catalogDetailRepair"/);
  assert.match(details[1], /id="catalogSubtitleRepair"/);
  assert.doesNotMatch(details[1], /id="catalogDetailPrimaryRepair"/);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.includes('catalogDetailPrimaryRepair'));
});

test('sixteen fully finished summary rows show completion with only optional closed replacement actions', async () => {
  const records = Array.from({ length: 16 }, (_, index) => catalogRecord(result(`owned-ready-${index}`)));
  const ui = await boot({ records, savedSettings: settings });
  assert.equal(ui.elements.get('catalogRows').childNodes.length, 16);
  for (const record of records) {
    const row = rowFor(ui, record.id); assert(row);
    assertNoDefaultRepair(row);
    const extra = moreActions(row); assert(extra); assert(hasClass(extra, 'catalog-extra-actions'));
    assert.equal(Boolean(extra.open), false);
    assert(namedButton(extra, /^원문부터 다시 분석$/));
    assert(namedButton(extra, /^한국어 자막 다시 번역$/));
    assert.match(textOf(row), /4 \/ 4구간/);
  }
  assert.equal(posts(ui).length, 0, 'loading a list never creates a recovery job');
});

test('opening additional row actions alone submits nothing and exposes the two deliberate replacement choices', async () => {
  const record = catalogRecord(result('owned-open-extra'));
  const ui = await boot({ records: [record], savedSettings: settings });
  const row = rowFor(ui, record.id), extra = moreActions(row); assert(extra);
  assertNoDefaultRepair(row);
  extra.open = true; await extra.dispatch('toggle');
  const visible = visibleButtons(row).map(button => button.textContent);
  assert(visible.includes('원문부터 다시 분석')); assert(visible.includes('한국어 자막 다시 번역'));
  assert.equal(posts(ui).length, 0);
});

for (const translationOnly of [false, true]) test(`an explicit additional ${translationOnly ? 'retranslation' : 'reanalysis'} uses only its existing endpoint`, async () => {
  const record = catalogRecord(result(`owned-extra-${translationOnly ? 'translation' : 'analysis'}`));
  const ui = await boot({ records: [record], savedSettings: settings });
  const extra = moreActions(rowFor(ui, record.id)); assert(extra); extra.open = true;
  const button = namedButton(extra, translationOnly ? /^한국어 자막 다시 번역$/ : /^원문부터 다시 분석$/); assert(button);
  await button.dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/${translationOnly ? 'subtitles/repair' : 'repair'}`);
  assert.equal(posts(ui)[0].body.options.mode, 'codex');
  if (translationOnly) {
    assert.equal(posts(ui)[0].body.options.transcribeAudio, false);
    assert.equal(posts(ui)[0].body.options.subtitleLanguage, 'ko');
  } else assert.equal(posts(ui)[0].body.options.transcribeAudio, true);
});

test('a finished detail view hides primary repair and leaves legacy controls behind the additional-actions disclosure', async () => {
  const record = result('owned-ready-detail');
  const ui = await boot({ records: [record], savedSettings: settings });
  await openDetail(ui, record.id);
  assert(hidden(ui.elements.get('catalogDetailPrimaryRepair')));
  const extra = ui.elements.get('catalogDetailExtraActions'); assert(extra);
  assert.equal(Boolean(extra.open), false);
  assert.match(ui.elements.get('catalogDetailRepair').textContent, /다시 분석/);
  assert.match(ui.elements.get('catalogSubtitleRepair').textContent, /한국어.*번역/);
  assert.match(ui.elements.get('catalogDetailHealth').textContent, /완료/);
  assert.equal(posts(ui).length, 0);
  extra.open = true; await extra.dispatch('toggle');
  assert.equal(posts(ui).length, 0);
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/subtitles/repair`);
});

test('unfinished Korean cues retain a primary missing-only recovery in the row and the detail view', async () => {
  const record = result('owned-missing-cues', { completed: 2, total: 10 });
  const rowUi = await boot({ records: [catalogRecord(record)], savedSettings: settings });
  const row = rowFor(rowUi, record.id);
  const rowRecovery = visibleButtons(row).find(button => button.textContent === '남은 8구간 번역 복구'); assert(rowRecovery);
  assert(!visibleButtons(row).some(button => /^(?:복구 \/ |원문부터 )?다시 분석$/.test(button.textContent)));
  await rowRecovery.dispatch('click');
  assert.equal(posts(rowUi).length, 1);
  assert.equal(posts(rowUi)[0].url, `/api/analysis/results/${record.id}/subtitles/repair`);
  const detailUi = await boot({ records: [record], savedSettings: settings });
  await openDetail(detailUi, record.id);
  const primary = detailUi.elements.get('catalogDetailPrimaryRepair'); assert(!hidden(primary));
  assert.match(primary.textContent, /번역.*(?:복구|계속)/);
  await primary.dispatch('click');
  assert.equal(posts(detailUi).length, 1);
  assert.equal(posts(detailUi)[0].url, `/api/analysis/results/${record.id}/subtitles/repair`);
});

test('a missing summary with fully translated subtitles offers summary or whole-analysis recovery instead of translation repair', async () => {
  const record = result('owned-missing-summary', { summary: false });
  const ui = await boot({ records: [record], savedSettings: settings });
  const visible = visibleButtons(rowFor(ui, record.id));
  const primaryRow = visible.find(button => /줄거리|요약|분석.*복구|복구.*분석/.test(button.textContent)); assert(primaryRow);
  assert(!visible.some(button => /번역.*(?:복구|계속)/.test(button.textContent)));
  await openDetail(ui, record.id);
  const primary = ui.elements.get('catalogDetailPrimaryRepair'); assert(!hidden(primary));
  assert.match(primary.textContent, /줄거리|요약|분석.*복구|복구.*분석/);
  await primary.dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/repair`);
});

test('a failed record without original cues offers whole-analysis recovery instead of an empty translation-only request', async () => {
  const record = result('owned-no-source-failed', { completed: 0, total: 0 });
  delete record.subtitleLanguage; delete record.subtitleTranslation;
  record.subtitleTranslationPartial = [];
  record.subtitleTranslationProgress.complete = false; record.subtitleTranslationProgress.translationComplete = false;
  record.status = 'failed'; record.error = '합성 원문 인식 실패'; record.health = recordHealth(record);
  const ui = await boot({ records: [record], savedSettings: settings });
  await openDetail(ui, record.id);
  const primary = ui.elements.get('catalogDetailPrimaryRepair'); assert(!hidden(primary));
  await primary.dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/repair`);
});

test('fully translated source-review warnings stay distinct from untranslated subtitles and do not demand default translation recovery', async () => {
  const record = result('owned-source-warning', { sourceReview: true });
  const ui = await boot({ records: [record], savedSettings: settings });
  const row = rowFor(ui, record.id); assertNoDefaultRepair(row);
  assert.match(textOf(row), /원어.*확인/);
  assert.doesNotMatch(textOf(row), /미번역 [1-9]|남은 [1-9].*번역 복구/);
  await openDetail(ui, record.id);
  assert(hidden(ui.elements.get('catalogDetailPrimaryRepair')));
  assert.match(ui.elements.get('catalogDetailHealth').textContent + ' ' + ui.elements.get('catalogDetailRepairNote').textContent, /원어.*확인/);
  assert.equal(posts(ui).length, 0);
});

test('a compact N/N save failure offers only file-save retry as its primary row action and guards duplicate clicks', async () => {
  const full = result('owned-save-failed', { saveFailed: true });
  const record = catalogRecord(full);
  const saved = { status: 'saved', path: 'Z:\\OWNED_ACTION_UI_ONLY\\owned-save-failed.ko.srt', generated: true };
  const updated = { ...full, status: 'completed', subtitleAutoSave: saved, savedAt: '2026-10-20T01:02:03.000Z' };
  updated.health = recordHealth(updated);
  const ui = await boot({ records: [record], savedSettings: settings, delayFolderSave: true,
    folderSaveResponse: { record: updated, subtitleAutoSave: saved } });
  const row = rowFor(ui, record.id);
  const button = visibleButtons(row).find(node => node.textContent === '자막 파일 다시 저장'); assert(button);
  assert(hasClass(button, 'catalog-save-retry')); assert.equal(button.dataset.recordId, record.id);
  assert(!visibleButtons(row).some(node => /번역.*(?:복구|계속)|복구 \/ 다시 분석/.test(node.textContent)));
  const saving = button.dispatch('click'); await flush();
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/subtitles/save`);
  await button.dispatch('click'); assert.equal(posts(ui).length, 1);
  ui.releaseFolderSave(); await saving;
  assert.equal(posts(ui).length, 1, 'file retry never starts analysis, translation or another save automatically');
});

test('the detail save-failure primary action retries the file endpoint while retaining the general folder-save tool', async () => {
  const record = result('owned-detail-save-failed', { saveFailed: true });
  const saved = { status: 'saved', path: 'Z:\\OWNED_ACTION_UI_ONLY\\owned-detail-save-failed.ko.srt', generated: true };
  const updated = { ...record, status: 'completed', subtitleAutoSave: saved }; updated.health = recordHealth(updated);
  const ui = await boot({ records: [record], savedSettings: settings, folderSaveResponse: { record: updated, subtitleAutoSave: saved } });
  await openDetail(ui, record.id);
  const primary = ui.elements.get('catalogDetailPrimaryRepair'); assert(!hidden(primary));
  assert.equal(primary.textContent, '자막 파일 다시 저장');
  assert(ui.elements.get('catalogSubtitleSaveFolder'), 'the ordinary download-tool save control still exists');
  await primary.dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/subtitles/save`);
});

test('N/N explicitly awaiting final review is not mistaken for a fully finished result', async () => {
  const record = result('owned-unchecked', { unchecked: true });
  const ui = await boot({ records: [record], savedSettings: settings });
  const row = rowFor(ui, record.id);
  assert.match(textOf(row), /최종 검수 필요/);
  assert(visibleButtons(row).some(button => /번역|검수/.test(button.textContent)), 'real unfinished proof keeps an explicit primary action');
  await openDetail(ui, record.id);
  const primary = ui.elements.get('catalogDetailPrimaryRepair'); assert(!hidden(primary));
  await primary.dispatch('click');
  assert.equal(posts(ui).length, 1);
  assert.equal(posts(ui)[0].url, `/api/analysis/results/${record.id}/subtitles/repair`);
});

test('an active analysis keeps its progress visible and prevents duplicate requests through both primary and additional actions', async () => {
  const record = result('owned-active-existing', { completed: 2, total: 4 });
  const active = { id: 'owned-active-job', source: 'repair', operation: 'translation-only', repairOf: record.id, status: 'running',
    currentFile: record.name, currentFilePath: record.path, total: 1, completed: 0, stage: '합성 번역 검수 중', percent: 42, results: [] };
  const ui = await boot({ records: [record], savedSettings: settings, initialActiveJob: active, jobResponse: () => active });
  const row = rowFor(ui, record.id); assert(hasClass(row, 'catalog-row-active'));
  assert.match(textOf(row), /검수 중|복구 중|번역 중/);
  const extra = moreActions(row); assert(extra); extra.open = true;
  for (const button of nodes(extra).filter(node => node.tag === 'button')) {
    assert.equal(button.disabled, true); await button.dispatch('click');
  }
  await openDetail(ui, record.id);
  const primary = ui.elements.get('catalogDetailPrimaryRepair'); assert.equal(primary.disabled, true);
  await primary.dispatch('click');
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  await ui.elements.get('catalogSubtitleRepair').dispatch('click');
  assert.equal(posts(ui).length, 0);
});

test('a failed replacement attempt preserves previous completed subtitles without showing primary translation recovery', async () => {
  const record = result('owned-complete-before-attempt');
  record.status = 'partial'; record.subtitleRepairStatus = 'failed';
  record.subtitleError = 'Owned synthetic 503 from the latest replacement attempt';
  record.health = recordHealth(record);
  const terminal = { id: 'owned-failed-retranslation-job', source: 'repair', operation: 'translation-only', repairOf: record.id,
    status: 'completed', total: 1, completed: 1, currentFile: record.name, currentFilePath: record.path, results: [record] };
  const ui = await boot({ records: [record], savedSettings: settings, initialActiveJob: terminal });
  assert.match(ui.elements.get('catalogJobTitle').textContent, /기존 한국어 자막 보관 · 재번역 요청 실패$/);
  assert.doesNotMatch(ui.elements.get('catalogJobTitle').textContent, /한국어 번역 미완료/);
  assertNoDefaultRepair(rowFor(ui, record.id));
  assert.match(textOf(rowFor(ui, record.id)), /4 \/ 4구간/);
  await openDetail(ui, record.id);
  assert(hidden(ui.elements.get('catalogDetailPrimaryRepair')));
  const notice = ['catalogDetailRepairNote', 'catalogSubtitleNotice', 'catalogSubtitleQualityNotice'].map(id => ui.elements.get(id)?.textContent || '').join(' ');
  assert.match(notice, /503|최근|시도|실패/);
  assert.equal(posts(ui).length, 0);
});
