const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { catalogRecord } = require('../lib/catalog-record');

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
const flush = () => new Promise(setImmediate);
const allNodes = node => [node, ...(node?.childNodes || []).flatMap(allNodes)];
const textOf = node => allNodes(node).map(child => child.textContent || '').join(' ');
const hasClass = (node, name) => (node?.className || '').split(/\s+/).includes(name) || node?.classList?.contains(name);
const findClass = (node, name) => allNodes(node).find(child => hasClass(child, name));
const rowFor = (ui, id) => ui.elements.get('catalogRows').childNodes.find(row => row.childNodes[1]?.childNodes[0]?.dataset?.recordId === id);
const renderedIds = ui => Array.from(ui.elements.get('catalogRows').childNodes, row => row.childNodes[1]?.childNodes[0]?.dataset?.recordId).filter(Boolean);
const infoFor = (ui, id) => findClass(rowFor(ui, id), 'catalog-subtitle-counts');
const repairFor = (ui, id) => allNodes(rowFor(ui, id)).find(node => node.tag === 'button' && /남은 [\d,]+구간 번역 복구/.test(node.textContent));
const settings = { mode: 'codex', subtitleQuality: 'accurate', subtitleLanguage: 'ko', transcriptLanguage: 'ja', frameCount: 10 };

function compact(id, { total = 2000, translated = 200, attempted = true, complete = false, sourceReview = false, saveFailed = false, health = true } = {}) {
  const completion = { totalCues: total, completedCues: translated, pendingCues: total - translated,
    translationComplete: complete, sourceReviewRequired: sourceReview, subtitleSaveFailed: saveFailed };
  return { catalogView: 'summary', id, path: `Z:\\OWNED_UI_ONLY\\${id}.mp4`, name: `${id}.mp4`, ext: 'MP4',
    status: 'completed', summary: '합성 열차 안내 요약', dialogueSummary: '안내 방송의 합성 대사 요약', frames: [], labels: [],
    transcriptCount: total, subtitleTranslatedCount: translated, subtitleTranslationSourceFingerprint: 'a'.repeat(64),
    subtitleTranslationAttempted: attempted, subtitleTranslationComplete: complete, subtitlePendingCount: total - translated,
    ...(health ? { health: { code: complete ? 'ready' : 'partial', reason: '합성 상태 정보', completion } } : {}) };
}

function fullPartial(id, { count = 10, indexes = [0, 1, 3, 4, 5, 7, 8, 9], complete = false } = {}) {
  const transcript = Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 4 + 0.5,
    end: index * 4 + 3.5, text: '合成の案内です。' }));
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(transcript.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex');
  const translation = indexes.map(index => ({ ...transcript[index], text: '합성 안내입니다.' }));
  return { id, path: `Z:\\OWNED_UI_ONLY\\${id}.mp4`, name: `${id}.mp4`, ext: 'MP4', status: 'completed', analysisMode: 'codex',
    summary: '합성 열차 안내 요약', dialogueSummary: '합성 안내 방송', frames: [], labels: [], transcript, transcriptLanguage: 'ja',
    ...(complete ? { subtitleLanguage: 'ko', subtitleTranslation: translation } : { subtitleTranslationPartial: translation }),
    subtitleTranslationProgress: { version: complete ? 1 : 2, ...(complete ? {} : { cueIndexes: indexes }), language: 'ko',
      totalCues: count, completedCues: translation.length, complete, translationComplete: complete, sourceComplete: true,
      sourceProcessed: true, sourceAuditComplete: true, sourceFingerprint } };
}

function assertCounts(ui, id, { translated, total, pending, incomplete = true, progressRequired = true }) {
  const row = rowFor(ui, id), block = infoFor(ui, id);
  assert(block, 'the row displays a dedicated Korean subtitle count block');
  assert(allNodes(row.childNodes[4]).includes(block), 'subtitle counts stay in the fifth dialogue-summary cell');
  assert.match(textOf(block), /한국어 자막/);
  const strong = allNodes(block).find(node => node.tag === 'strong' && node.textContent === `${translated.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}구간`);
  assert(strong, 'the exact translated/total count is emphasized');
  if (pending > 0) assert.match(textOf(block), new RegExp(`미번역 ${pending.toLocaleString('ko-KR')}구간`));
  const progress = allNodes(block).find(node => node.tag === 'progress');
  if (progressRequired) assert(progress, 'a semantic progress element accompanies known nonzero counts');
  if (progress) {
    assert.equal(Number(progress.value ?? progress.attributes?.value), translated);
    assert.equal(Number(progress.max ?? progress.attributes?.max), total);
  }
  assert.equal(Boolean(findClass(row, 'catalog-subtitle-incomplete')), incomplete);
  return block;
}

test('subtitle counts and an explicit incomplete filter have stable unique HTML controls', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter(id => id === 'catalogSubtitleIncomplete').length, 1);
  const filter = html.match(/<select id="catalogStatusFilter"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.match(filter || '', /<option value="subtitle-incomplete"[^>]*>[^<]*자막/);
  assert.match(html, /id="catalogSubtitleIncomplete"[^>]*type="button"|type="button"[^>]*id="catalogSubtitleIncomplete"/);
});

test('a nominally completed summary record still shows 200/2000 Korean cues and 1800 untranslated cues without an error or progress object', async () => {
  const full = fullPartial('owned-needs-200', { count: 2000, indexes: Array.from({ length: 200 }, (_, index) => index) });
  full.subtitleTranslationProgress.version = 1; delete full.subtitleTranslationProgress.cueIndexes;
  const record = catalogRecord(full);
  assert.equal(record.status, 'completed'); assert.equal(record.error, undefined); assert.equal(record.subtitleTranslationProgress, undefined);
  const ui = await boot({ records: [record], savedSettings: settings });
  const block = assertCounts(ui, record.id, { translated: 200, total: 2000, pending: 1800 });
  const repair = repairFor(ui, record.id); assert(repair);
  assert.equal(repair.textContent, '남은 1,800구간 번역 복구');
  assert(allNodes(rowFor(ui, record.id).childNodes[4]).includes(repair), 'recovery is visible alongside the dialogue counts');
  assert(allNodes(rowFor(ui, record.id)).indexOf(repair) > allNodes(rowFor(ui, record.id)).indexOf(block));
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0, 'rendering counts never starts translation automatically');
});

test('health completion counts take priority over conflicting compact counters while validated compact fallback remains available', async () => {
  const authoritative = compact('owned-health-first');
  authoritative.subtitleTranslatedCount = 400; authoritative.subtitlePendingCount = 1600;
  const fallback = compact('owned-compact-fallback', { health: false });
  const ui = await boot({ records: [authoritative, fallback], savedSettings: settings });
  for (const record of [authoritative, fallback]) assertCounts(ui, record.id, { translated: 200, total: 2000, pending: 1800 });
});

test('a real validated v2 sparse projection counts all accepted global indexes rather than the first contiguous prefix', async () => {
  const full = fullPartial('owned-v2-holes');
  const record = catalogRecord(full);
  assert.equal(record.subtitleTranslatedCount, 8); assert.equal(record.transcriptCount, 10);
  const ui = await boot({ records: [record], savedSettings: settings });
  assertCounts(ui, record.id, { translated: 8, total: 10, pending: 2 });
  assert.equal(repairFor(ui, record.id).textContent, '남은 2구간 번역 복구');
});

test('an attempted zero translation shows every source cue pending and an explicit recovery action', async () => {
  const record = compact('owned-zero', { total: 1200, translated: 0 });
  const ui = await boot({ records: [record], savedSettings: settings });
  assertCounts(ui, record.id, { translated: 0, total: 1200, pending: 1200 });
  assert.equal(repairFor(ui, record.id).textContent, '남은 1,200구간 번역 복구');
});

test('an original-language-only record displays translation before-start state and stays out of the incomplete filter', async () => {
  const record = compact('owned-original-only', { total: 1200, translated: 0, attempted: false });
  const ui = await boot({ records: [record], savedSettings: settings });
  const block = assertCounts(ui, record.id, { translated: 0, total: 1200, pending: 0, incomplete: false, progressRequired: false });
  assert.match(textOf(block), /번역 전/);
  assert.doesNotMatch(textOf(block), /미번역/);
  assert.equal(repairFor(ui, record.id), undefined);
  ui.elements.get('catalogStatusFilter').value = 'subtitle-incomplete';
  await ui.elements.get('catalogStatusFilter').dispatch('change');
  assert.deepEqual(renderedIds(ui), []);
});

test('N/N with explicit incomplete proof requests final review while fully translated source-review or save failures remain separate', async () => {
  const unchecked = compact('owned-final-review', { total: 2000, translated: 2000, complete: false });
  const complete = compact('owned-full', { total: 2000, translated: 2000, complete: true });
  const sourceReview = compact('owned-source-review', { total: 2000, translated: 2000, complete: true, sourceReview: true });
  const saveFailed = compact('owned-save-failed', { total: 2000, translated: 2000, complete: true, saveFailed: true });
  const ui = await boot({ records: [unchecked, complete, sourceReview, saveFailed], savedSettings: settings });
  assertCounts(ui, unchecked.id, { translated: 2000, total: 2000, pending: 0 });
  assert.match(textOf(infoFor(ui, unchecked.id)), /최종 검수 필요/);
  for (const record of [complete, sourceReview, saveFailed]) {
    assertCounts(ui, record.id, { translated: 2000, total: 2000, pending: 0, incomplete: false });
    assert.doesNotMatch(textOf(infoFor(ui, record.id)), /미번역|최종 검수 필요/);
  }
  assert.match(textOf(rowFor(ui, sourceReview.id)), /원어.*확인/);
  assert.match(textOf(rowFor(ui, saveFailed.id)), /저장.*(?:실패|확인|문제)/);
  ui.elements.get('catalogStatusFilter').value = 'subtitle-incomplete';
  await ui.elements.get('catalogStatusFilter').dispatch('change');
  assert.deepEqual(renderedIds(ui), [unchecked.id]);
});

test('an attempted translation without source cues stays visibly unresolved without a misleading 0/0 completion ratio', async () => {
  const record = compact('owned-no-source', { total: 0, translated: 0 });
  const ui = await boot({ records: [record], savedSettings: settings });
  const block = infoFor(ui, record.id); assert(block);
  assert.match(textOf(block), /원문 구간 확인 필요/);
  assert.doesNotMatch(textOf(block), /0\s*\/\s*0|번역 완료|자막 완료/);
  assert.equal(allNodes(block).some(node => node.tag === 'progress'), false);
  assert.equal(repairFor(ui, record.id), undefined, 'a text-only repair cannot start without source cues');
  ui.elements.get('catalogStatusFilter').value = 'subtitle-incomplete';
  await ui.elements.get('catalogStatusFilter').dispatch('change');
  assert.deepEqual(renderedIds(ui), [record.id]);
});

test('malformed compact count metadata never fabricates a ratio, progress maximum or a completed subtitle', async () => {
  for (const [translated, total] of [[-1, 2000], [2001, 2000], [1.5, 2000], ['200', 2000], [200, -1], [200, '2000']]) {
    const record = compact('owned-invalid-counts', { translated, total, health: false });
    const ui = await boot({ records: [record], savedSettings: settings });
    const block = infoFor(ui, record.id); assert(block, 'attempted records keep an explicit unknown state');
    assert(!allNodes(block).some(node => node.tag === 'progress'), `${translated}/${total}: untrusted numeric pairs do not create a progress bar`);
    assert(!allNodes(block).some(node => node.tag === 'strong' && /\d.*\/.*\d/.test(node.textContent)));
    assert.doesNotMatch(textOf(block), /자막 완료|번역 완료/);
  }
});

test('the incomplete shortcut enables saved records and counts all matching pages rather than only the visible page', async () => {
  const pending = Array.from({ length: 63 }, (_, index) => compact(`owned-pending-${String(index).padStart(3, '0')}`));
  const other = [compact('owned-complete-other', { translated: 2000, complete: true }),
    compact('owned-original-other', { translated: 0, attempted: false })];
  const ui = await boot({ records: [...pending, ...other], savedSettings: settings });
  ui.elements.get('catalogShowSaved').checked = false;
  await ui.elements.get('catalogShowSaved').dispatch('change');
  const shortcut = ui.elements.get('catalogSubtitleIncomplete'); assert(shortcut);
  assert.match(shortcut.textContent, /63/);
  await shortcut.dispatch('click');
  assert.equal(ui.elements.get('catalogShowSaved').checked, true);
  assert.equal(ui.elements.get('catalogStatusFilter').value, 'subtitle-incomplete');
  const seen = new Set(renderedIds(ui));
  assert.equal(seen.size, 40); assert.equal(ui.elements.get('catalogNextPage').disabled, false);
  await ui.elements.get('catalogNextPage').dispatch('click');
  renderedIds(ui).forEach(id => seen.add(id));
  assert.equal(renderedIds(ui).length, 23); assert.equal(seen.size, 63);
  assert.deepEqual([...seen].sort(), pending.map(record => record.id).sort());
  assert.match(shortcut.textContent, /63/);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('the visible count-block repair posts only the clicked record ID to translation repair and ignores duplicate busy clicks', async () => {
  const target = compact('owned-repair-target');
  const neighbour = compact('owned-repair-neighbour', { translated: 100 });
  const ui = await boot({ records: [target, neighbour], savedSettings: settings, delayRepair: true });
  const button = repairFor(ui, target.id); assert(button);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
  const starting = button.dispatch('click'); await flush();
  const requests = () => ui.calls.filter(call => call.method === 'POST' && call.url.includes('/results/'));
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].url, `/api/analysis/results/${target.id}/subtitles/repair`);
  assert.equal(requests()[0].body.options.mode, 'codex');
  assert.equal(requests()[0].body.options.transcribeAudio, false);
  assert.equal(requests()[0].body.options.subtitleLanguage, 'ko');
  await button.dispatch('click');
  assert.equal(requests().length, 1, 'the detached original button cannot start a second request while busy');
  const newButton = allNodes(rowFor(ui, target.id)).find(node => node.tag === 'button' && hasClass(node, 'catalog-translation-repair-button'))
    || allNodes(rowFor(ui, target.id).childNodes[4]).find(node => node.tag === 'button');
  assert(newButton?.disabled, 'the currently rendered recovery action reflects the in-flight request');
  assert(!ui.calls.some(call => call.method === 'POST' && (call.url === '/api/analysis/jobs' || call.url === `/api/analysis/results/${target.id}/repair`)));
  ui.releaseRepair(); await starting;
  assert.equal(requests().length, 1);
});

test('a visible count-block action stays disabled when the provider is unavailable or the same video is active', async () => {
  const record = compact('owned-repair-unavailable');
  for (const active of [false, true]) {
    const ui = await boot({ records: [record], savedSettings: settings,
      ...(active ? { initialActiveJob: { id: 'owned-other-active-job', status: 'running', total: 1, completed: 0,
        currentFile: record.name, currentFilePath: record.path, results: [], stage: '합성 처리 중' } }
        : { providerStatus: { codex: { available: false, loggedIn: false }, speech: { available: false } } }) });
    const button = allNodes(rowFor(ui, record.id)).find(node => node.tag === 'button' && node.dataset.translationRepairId === record.id); assert(button);
    assert.equal(button.disabled, true);
    await button.dispatch('click');
    assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0, 'even a direct stale click cannot bypass the readiness or busy guard');
  }
});

test('count-block translation repair stays available with a ready Codex login even when local speech recognition is unavailable', async () => {
  const record = compact('owned-repair-without-asr');
  const ui = await boot({ records: [record], savedSettings: settings,
    providerStatus: { codex: { available: true, loggedIn: true }, speech: { available: false } } });
  const button = repairFor(ui, record.id); assert(button);
  assert.equal(button.disabled, false, 'saved-text translation does not require another audio decode');
  await button.dispatch('click');
  const requests = ui.calls.filter(call => call.method === 'POST');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/analysis/results/${record.id}/subtitles/repair`);
  assert.equal(requests[0].body.options.transcribeAudio, false);
});

test('a retained complete translation does not become untranslated because a later replacement attempt failed', async () => {
  const record = compact('owned-retained-full-after-failure', { translated: 2000, complete: true, sourceReview: true });
  record.status = 'partial'; record.subtitleRepairStatus = 'failed';
  record.subtitleError = 'Owned synthetic 503 from a later replacement attempt';
  const ui = await boot({ records: [record], savedSettings: settings });
  assertCounts(ui, record.id, { translated: 2000, total: 2000, pending: 0, incomplete: false });
  assert.equal(repairFor(ui, record.id), undefined);
  ui.elements.get('catalogStatusFilter').value = 'subtitle-incomplete';
  await ui.elements.get('catalogStatusFilter').dispatch('change');
  assert.deepEqual(renderedIds(ui), [], 'validated complete subtitles outrank a later attempt error when identifying missing translations');
});
