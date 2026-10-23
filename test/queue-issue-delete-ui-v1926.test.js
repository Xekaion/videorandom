const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Synthetic in-memory DOM and HTTP fixtures only. Never use actual media,
// providers, analysis records, a production browser or a running local server.
const fixtureFile = path.join(__dirname, 'completed-actions-ui-v1914.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8');
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot, result, rowFor, nodes, textOf, settings };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, result, rowFor, nodes, textOf, settings } = fixtureModule.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(setImmediate);
const id = number => number.toString(16).padStart(32, '0');
const issue = (number = 1) => ({ recordId: id(number), name: `owned-deletion-${number}.mp4`,
  path: `Z:\\OWNED_HISTORY_DELETE_UI_ONLY\\owned-deletion-${number}.mp4`, code: 'ANALYSIS_PARTIAL',
  reason: '합성 영상의 부분 결과를 보관했습니다.', recordedAt: '2026-10-24T03:00:00.000Z', totalCues: 12, completedCues: 3 });
const queue = (issues = [issue()], extra = {}) => ({ enabled: true, paused: false, configured: true, options: settings,
  pendingCount: 0, pending: [], waitingReason: '', activeAutoPath: '', activeJob: null,
  fileIssues: { total: issues.length, items: issues }, ...extra });
const deletes = ui => ui.calls.filter(call => call.method === 'DELETE');
const deleteButton = (ui, number) => nodes(ui.elements.get('catalogQueueIssueItems')).find(node => node.dataset?.queueIssueDeleteId === id(number));
const detailButton = (ui, number) => nodes(ui.elements.get('catalogQueueIssueItems')).find(node => node.dataset?.queueIssueId === id(number));
const hidden = node => node.classList.contains('hidden');
const respond = (value, status = 200) => ({ ok: status < 400, status, json: async () => plain(value) });

function installDelete(ui, handler) {
  const original = ui.sandbox.fetch;
  ui.sandbox.fetch = async (url, options = {}) => {
    if (url !== '/api/analysis/queue/issues') return original(url, options);
    const call = { url, method: options.method, body: JSON.parse(options.body) };
    ui.calls.push(call);
    if (handler) return handler(call);
    const current = plain(ui.getQueue());
    const before = current.fileIssues.items;
    const remaining = call.body.clearAll === true ? [] : before.filter(item => !(item.recordId === call.body.recordId && item.recordedAt === call.body.recordedAt));
    const removedCount = before.length - remaining.length;
    current.fileIssues = { total: remaining.length, items: remaining };
    ui.setQueue(current);
    return respond({ removedCount, fileIssues: current.fileIssues, queue: current });
  };
}

test('history starts folded and the expanded list has a bounded scroll region', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const disclosure = html.match(/<details\b[^>]*id="catalogQueueIssuesDisclosure"[^>]*>([\s\S]*?)<\/details>/);
  assert(disclosure);
  assert.doesNotMatch(disclosure[0].slice(0, disclosure[0].indexOf('>')), /\sopen(?:\s|=|>)/);
  assert.match(disclosure[1], /<summary>저장 기록 목록 펼치기<\/summary>/);
  assert.match(disclosure[1], /id="catalogQueueIssueItems"[^>]*tabindex="0"[^>]*role="region"/);
  const section = html.match(/<section id="catalogQueueIssues"[\s\S]*?<\/section>/)[0];
  assert(section.indexOf('id="catalogQueueIssuesClear"') < section.indexOf('<details'), 'clear is available without expanding the long list');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /#catalogQueueIssueItems\s*\{[^}]*max-height:\s*360px;[^}]*overflow-y:\s*auto;/);
});

test('individual deletion sends only the exact durable issue snapshot and retains catalog results', async () => {
  const record = result(id(1));
  const ui = await boot({ records: [record], savedSettings: settings, initialQueue: queue([issue(1), issue(2)]) });
  installDelete(ui);
  assert.match(ui.elements.get('catalogQueueIssuesNote').textContent, /분석 결과·자막 파일·오류 기록은 보관/);
  const button = deleteButton(ui, 1); assert(button);
  assert.equal(button.textContent, '목록에서 삭제');
  assert.match(button.attributes['aria-label'], /owned-deletion-1.*저장 기록을 목록에서 삭제/);
  await button.dispatch('click');
  assert.deepEqual(plain(deletes(ui)), [{ url: '/api/analysis/queue/issues', method: 'DELETE', body: { recordId: id(1), recordedAt: issue(1).recordedAt, code: issue(1).code } }]);
  assert.equal(deleteButton(ui, 1), undefined);
  assert(deleteButton(ui, 2));
  assert(rowFor(ui, record.id), 'the analysis result remains in the library');
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /저장 기록 1건.*삭제/);
  assert.equal(ui.calls.filter(call => call.method === 'POST').length, 0);
});

test('clear all covers stored issues beyond the twenty shown rows without clearing the analysis queue', async () => {
  const items = Array.from({ length: 27 }, (_, index) => issue(index + 1));
  const pending = [{ path: 'Z:\\OWNED_HISTORY_DELETE_UI_ONLY\\owned-pending.mp4', name: 'owned-pending.mp4' }];
  const ui = await boot({ savedSettings: settings, initialQueue: queue(items, { paused: true, pending, pendingCount: 1 }) });
  installDelete(ui);
  assert.equal(nodes(ui.elements.get('catalogQueueIssueItems')).filter(node => node.dataset?.queueIssueDeleteId).length, 20);
  await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  assert.deepEqual(deletes(ui)[0].body, { clearAll: true });
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /27건/);
  assert.equal(ui.getQueue().paused, true);
  assert.deepEqual(ui.getQueue().pending, pending);
  assert.equal(deletes(ui).some(call => call.url.endsWith('/pending')), false);
});

test('an active analysis and its progress do not disable history deletion or get changed by its response', async () => {
  const record = result(id(30));
  const active = { id: 'owned-active-deletion', source: 'auto-pick', status: 'running', total: 1, completed: 0,
    currentFile: record.name, currentFilePath: record.path, stage: '합성 진행 상태', percent: 57, results: [] };
  const ui = await boot({ records: [record], savedSettings: settings, initialQueue: queue([issue()], { activeJob: active, activeAutoPath: record.path }) });
  installDelete(ui, () => respond({ removedCount: 1, fileIssues: { total: 0, items: [] }, queue: queue([], { paused: true, activeJob: null }) }));
  assert.equal(ui.elements.get('catalogQueueIssuesClear').disabled, false);
  await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  assert.match(ui.elements.get('catalogJobFile').textContent, new RegExp(record.name.replace(/\./g, '\\.')));
  assert.match(ui.elements.get('catalogJobStage').textContent, /합성 진행 상태/);
  assert.equal(ui.elements.get('catalogQueuePause').textContent, '다음 분석 일시 중지');
  assert.equal(ui.calls.filter(call => call.method === 'POST' || call.method === 'PUT').length, 0);
});

test('a pending deletion blocks only duplicate history writes and exposes accessible busy state', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue([issue(1), issue(2)]) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  installDelete(ui, async () => { await gate; return respond({ removedCount: 1, fileIssues: { total: 1, items: [issue(2)] } }); });
  const deleting = deleteButton(ui, 1).dispatch('click');
  try {
    await flush();
    assert.equal(ui.elements.get('catalogQueueIssues').attributes['aria-busy'], 'true');
    assert.equal(deleteButton(ui, 1).textContent, '삭제 중…');
    assert.equal(deleteButton(ui, 2).disabled, true);
    assert.equal(ui.elements.get('catalogQueueIssuesClear').disabled, true);
    assert.equal(ui.elements.get('catalogQueuePause').disabled, false, 'unrelated queue controls are not locked');
    await deleteButton(ui, 2).dispatch('click');
    await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
    assert.equal(deletes(ui).length, 1);
  } finally { release(); await deleting; }
  assert.equal(deleteButton(ui, 2).disabled, false);
  assert.equal(ui.elements.get('catalogQueueIssues').attributes['aria-busy'], 'false');
});

test('clear all reports its own busy label and cannot submit twice', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  installDelete(ui, async () => { await gate; return respond({ removedCount: 1, fileIssues: { total: 0, items: [] } }); });
  const deleting = ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  try {
    await flush();
    assert.equal(ui.elements.get('catalogQueueIssuesClear').textContent, '기록 비우는 중…');
    await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
    assert.equal(deletes(ui).length, 1);
  } finally { release(); await deleting; }
});

for (const status of [404, 500]) test(`a ${status} deletion failure keeps the issue and offers another deliberate attempt`, async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  installDelete(ui, () => respond({ error: '합성 기록 저장 실패' }, status));
  await deleteButton(ui, 1).dispatch('click');
  assert(deleteButton(ui, 1));
  assert.equal(deleteButton(ui, 1).disabled, false);
  assert.equal(hidden(ui.elements.get('catalogQueueNotice')), false);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, status === 404 ? /최신 버전/ : /기록 삭제 실패.*합성 기록 저장 실패/);
  assert.equal(deletes(ui).length, 1, 'no automatic retry is issued');
});

test('a stale single deletion shows the newer issue rather than hiding it', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  const updated = { ...issue(), recordedAt: '2026-10-24T04:00:00.000Z', completedCues: 8 };
  installDelete(ui, () => respond({ removedCount: 0, fileIssues: { total: 1, items: [updated] } }));
  await deleteButton(ui, 1).dispatch('click');
  assert.match(textOf(ui.elements.get('catalogQueueIssueItems')), /8 \/ 12구간/);
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /새 기록으로 바뀌/);
  assert.equal(deletes(ui).length, 1);
});

test('a queue refresh already in flight cannot restore a deleted issue', async () => {
  const initial = queue();
  const ui = await boot({ savedSettings: settings, initialQueue: initial });
  installDelete(ui);
  const original = ui.sandbox.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let blocked = true;
  ui.sandbox.fetch = async (url, options = {}) => {
    if (url === '/api/analysis/queue?view=summary' && blocked) {
      blocked = false; await gate; return respond(initial);
    }
    return original(url, options);
  };
  const refreshing = ui.elements.get('catalogQueueRefresh').dispatch('click');
  try {
    await flush();
    await deleteButton(ui, 1).dispatch('click');
    assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
  } finally { release(); await refreshing; }
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true, 'old response cannot revive dismissed history');
  ui.setQueue(queue([issue(2)]));
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert(deleteButton(ui, 2), 'a later independent issue still appears');
});

test('a simultaneous queue pause response preserves successful history deletion and still updates pause state', async () => {
  const initial = queue();
  const ui = await boot({ savedSettings: settings, initialQueue: initial });
  installDelete(ui);
  const original = ui.sandbox.fetch;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  ui.sandbox.fetch = async (url, options = {}) => {
    if (url === '/api/analysis/queue' && options.method === 'PUT') {
      ui.calls.push({ url, method: 'PUT', body: JSON.parse(options.body) });
      await gate;
      const next = { ...plain(ui.getQueue()), paused: true };
      ui.setQueue(next);
      return respond({ queue: { ...plain(initial), paused: true } });
    }
    return original(url, options);
  };
  const pausing = ui.elements.get('catalogQueuePause').dispatch('click');
  try {
    await flush();
    assert.equal(ui.elements.get('catalogQueueIssuesClear').disabled, false);
    await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  } finally { release(); await pausing; }
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
  assert.equal(ui.elements.get('catalogQueuePause').textContent, '대기 분석 재개');
});

test('deleting a history entry retains already opened saved detail content', async () => {
  const historical = result(id(1), { completed: 1, total: 4 });
  const ui = await boot({ records: [historical], savedSettings: settings, initialQueue: queue() });
  installDelete(ui);
  const original = ui.sandbox.fetch;
  ui.sandbox.fetch = async (url, options) => url === `/api/analysis/results/${historical.id}` ? respond(historical) : original(url, options);
  await detailButton(ui, 1).dispatch('click');
  assert.equal(ui.elements.get('catalogDetail').open, true);
  await deleteButton(ui, 1).dispatch('click');
  assert.equal(ui.elements.get('catalogDetail').open, true);
  assert.equal(ui.elements.get('catalogDetailTitle').textContent, historical.name);
  assert(rowFor(ui, historical.id));
});

for (const hasItems of [true, false]) test(`a persistence error stays visible and prevents deletion with ${hasItems ? 'retained' : 'no'} rows`, async () => {
  const failed = queue(hasItems ? [issue()] : []);
  failed.fileIssues.error = '합성 삭제 기록을 읽지 못했습니다. 기존 기록은 보관됩니다.';
  const ui = await boot({ savedSettings: settings, initialQueue: failed });
  installDelete(ui);
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), false);
  assert.equal(hidden(ui.elements.get('catalogQueueIssuesError')), false);
  assert.match(ui.elements.get('catalogQueueIssuesError').textContent, /기록을 읽지 못했습니다/);
  assert.equal(ui.elements.get('catalogQueueIssuesClear').disabled, true);
  await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  if (hasItems) { assert.equal(deleteButton(ui, 1).disabled, true); await deleteButton(ui, 1).dispatch('click'); }
  assert.equal(deletes(ui).length, 0);
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.match(ui.elements.get('catalogQueueIssuesError').textContent, /기록을 읽지 못했습니다/);
});

test('an invalid successful deletion response cannot silently empty retained history', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  installDelete(ui, () => respond({ removedCount: 1 }));
  await deleteButton(ui, 1).dispatch('click');
  assert(deleteButton(ui, 1));
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /저장 기록 응답을 확인하지 못했습니다/);
  assert.equal(deletes(ui).length, 1);
});

test('clearing focused history returns keyboard focus to the visible queue refresh control', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  installDelete(ui);
  let focused = false;
  ui.sandbox.document.activeElement = ui.elements.get('catalogQueueIssuesClear');
  ui.elements.get('catalogQueueRefresh').focus = () => { focused = true; };
  await ui.elements.get('catalogQueueIssuesClear').dispatch('click');
  assert.equal(focused, true);
  assert.equal(hidden(ui.elements.get('catalogQueueIssues')), true);
});

test('polling and deleting do not reset the user’s expanded or folded disclosure choice', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue([issue(1), issue(2)]) });
  installDelete(ui);
  const disclosure = ui.elements.get('catalogQueueIssuesDisclosure');
  disclosure.open = true;
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.equal(disclosure.open, true);
  await deleteButton(ui, 1).dispatch('click');
  assert.equal(disclosure.open, true);
  disclosure.open = false;
  await ui.elements.get('catalogQueueRefresh').dispatch('click');
  assert.equal(disclosure.open, false);
});

test('a stale snapshot 404 refreshes the issue list without claiming an old application version', async () => {
  const ui = await boot({ savedSettings: settings, initialQueue: queue() });
  installDelete(ui, () => {
    ui.setQueue(queue([issue(2)]));
    return respond({ error: '목록에서 기록을 찾을 수 없습니다. 목록을 새로 불러와 주세요.' }, 404);
  });
  const readsBefore = ui.calls.filter(call => call.url === '/api/analysis/queue?view=summary').length;
  await deleteButton(ui, 1).dispatch('click');
  assert.equal(deleteButton(ui, 1), undefined);
  assert(deleteButton(ui, 2));
  assert.match(ui.elements.get('catalogQueueNotice').textContent, /변경되었습니다.*새로 불러왔습니다/);
  assert.doesNotMatch(ui.elements.get('catalogQueueNotice').textContent, /최신 버전/);
  assert.equal(ui.calls.filter(call => call.url === '/api/analysis/queue?view=summary').length, readsBefore + 1);
  assert.equal(deletes(ui).length, 1, 'only metadata is refreshed, the deletion is not retried');
});
