const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Reuse only the synthetic in-memory UI fixture declarations, never its tests.
const fixtureFile = path.join(__dirname, 'completed-actions-ui-v1914.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8');
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot, result, rowFor, nodes, textOf, settings };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, result, rowFor, nodes, textOf, settings } = fixtureModule.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const id = number => number.toString(16).padStart(32, '0');
const issue = (number = 1) => ({ recordId: id(number), name: `owned-skipped-${number}.mp4`,
  path: `Z:\\OWNED_QUEUE_ISSUE_UI_ONLY\\owned-skipped-${number}.mp4`, code: 'ANALYSIS_PARTIAL',
  reason: '이 영상의 일부 결과를 저장하고 다음 영상으로 넘어갔습니다.',
  recordedAt: '2026-10-21T03:00:00.000Z', totalCues: 12, completedCues: 3 });
const queue = (issues = [issue()], activeJob = null) => ({ enabled: true, paused: false, configured: true, options: settings,
  pendingCount: 0, pending: [], waitingReason: '', activeAutoPath: '', activeJob,
  fileIssues: { total: issues.length, items: issues } });
const hidden = element => element.classList.contains('hidden');
const writes = ui => ui.calls.filter(call => call.method !== 'GET');

test('saved queue issue names and counts remain visible while the next analysis runs', async () => {
  const next = result('owned-next-video');
  const active = { id: 'owned-next-job', source: 'auto-pick', status: 'running', total: 1, completed: 0,
    currentFile: next.name, currentFilePath: next.path, stage: '합성 분석 진행', percent: 30, results: [] };
  const ui = await boot({ records: [next], savedSettings: settings, initialQueue: queue([issue()], active) });
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), false);
  assert.match(ui.elements.get('catalogQueueIssuesTitle').textContent, /저장 기록 1건/);
  assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /owned-skipped-1\.mp4/);
  assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /3 \/ 12구간/);
  assert.match(ui.elements.get('catalogJobFile').textContent, /owned-next-video/);
  assert.equal(writes(ui).length, 0);
  const replacement = { ...active, id: 'owned-third-job', currentFile: 'owned-third-video.mp4' };
  ui.setQueue(queue([issue()], replacement));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.match(ui.elements.get('catalogJobFile').textContent, /owned-third-video/);
  assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /owned-skipped-1\.mp4/);
  assert.equal(writes(ui).length, 0);
});

test('queue history refreshes even when pending paths and controls do not change', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue([]) });
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
  ui.setQueue(queue([issue(2)]));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), false);
  assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /owned-skipped-2/);
  ui.setQueue(queue([]));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
});

test('queue issue history is bounded to twenty items while preserving total attempt count', async () => {
  const initial = queue(Array.from({ length: 25 }, (_, index) => issue(index + 1)));
  const ui = await boot({ savedSettings: settings, initialQueue: initial });
  assert.match(ui.elements.get('catalogQueueIssuesTitle').textContent, /25건/);
  assert.match(ui.elements.get('catalogQueueIssuesNote').textContent, /최근 20건/);
  const buttons = nodes(ui.elements.get('catalogQueueIssueItems')).filter(node => node.dataset?.queueIssueId);
  assert.equal(buttons.length, 20);
  assert.equal(writes(ui).length, 0, 'history never retries an issue automatically');
});

test('opening a saved skipped attempt fetches its exact ID without replacing the best catalog result', async () => {
  const best = result(id(40));
  const historical = { ...result(id(41), { completed: 1, total: 4 }), path: best.path, name: 'owned-failed-attempt.mp4' };
  const entry = { ...issue(41), path: best.path, name: historical.name };
  const ui = await boot({ records: [best], savedSettings: settings, initialQueue: queue([entry]) });
  const originalFetch = ui.sandbox.fetch, detailRequests = [];
  ui.sandbox.fetch = async (url, options) => {
    if (url === `/api/analysis/results/${historical.id}`) {
      detailRequests.push(url); return { ok: true, json: async () => plain(historical) };
    }
    return originalFetch(url, options);
  };
  const button = nodes(ui.elements.get('catalogQueueIssueItems')).find(node => node.dataset?.queueIssueId === historical.id);
  assert(button); await button.dispatch('click');
  assert.deepEqual(detailRequests, [`/api/analysis/results/${historical.id}`]);
  assert.equal(ui.elements.get('catalogDetail').open, true);
  assert.equal(ui.elements.get('catalogDetailTitle').textContent, historical.name);
  assert(rowFor(ui, best.id), 'the prior completed catalog entry is retained');
  assert.equal(writes(ui).length, 0);
});

test('a fresh UI session reloads durable queue issues with no analysis request', async () => {
  const saved = queue([issue(3)]);
  const first = await boot({ savedSettings: settings, initialQueue: plain(saved) });
  const second = await boot({ savedSettings: settings, initialQueue: plain(saved) });
  for (const ui of [first, second]) {
    assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /owned-skipped-3/);
    assert.equal(writes(ui).length, 0);
  }
});

test('history uses text nodes and ignores malformed issue entries', async () => {
  const entry = { ...issue(4), name: '<img src=x onerror=alert(1)>.mp4', reason: '<script>synthetic()</script>' };
  const ui = await boot({ savedSettings: settings, initialQueue: queue([entry, { ...issue(5), recordId: '../unsafe' }]) });
  const panel = ui.elements.get('catalogQueueIssueItems');
  assert.match(textOf(panel), /<img src=x onerror=alert\(1\)>/);
  assert.equal(nodes(panel).some(node => node.tag === 'script' || node.tag === 'img'), false);
  assert.equal(nodes(panel).filter(node => node.dataset?.queueIssueId).length, 1);
  assert.equal(writes(ui).length, 0);
});

test('real HTML exposes an independent queue issue panel with unique accessible IDs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const section = html.match(/<section id="catalogQueueIssues"[\s\S]*?<\/section>/);
  assert(section); assert.match(section[0], /aria-labelledby="catalogQueueIssuesTitle"/);
  assert.match(section[0], /id="catalogQueueIssueItems"/);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
