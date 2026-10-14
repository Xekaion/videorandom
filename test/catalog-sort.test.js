const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_ORDER, normalizeOrder, sortFiles } = require('../public/js/catalog-sort');

const file = (name, path = `D:\\영상\\${name}`, extra = {}) => ({ name, path, ...extra });
const orderedNames = (files, records, order) => sortFiles(files, item => records.get(item.path), order).map(item => item.name);

test('completed files lead partial, pending and failed files across drives without altering sources', () => {
  const files = [file('미분석1.mp4', 'C:\\미분석1.mp4'), file('실패1.mp4'), file('완료2.mp4'), file('부분1.mp4'), file('완료10.mp4', 'Z:\\완료10.mp4')];
  const original = JSON.stringify(files);
  const records = new Map([
    [files[1].path, { status: 'failed', savedAt: '2026-10-14T04:00:00Z' }],
    [files[2].path, { status: 'completed', savedAt: '2026-10-13T04:00:00Z' }],
    [files[3].path, { status: 'partial', savedAt: '2026-10-14T04:00:00Z' }],
    [files[4].path, { status: 'completed', analyzedAt: '2026-10-14T04:00:00Z' }]
  ]);
  const beforeRecords = JSON.stringify([...records]);
  assert.deepEqual(orderedNames(files, records, 'completed-first'), ['완료10.mp4', '완료2.mp4', '부분1.mp4', '미분석1.mp4', '실패1.mp4']);
  assert.equal(JSON.stringify(files), original);
  assert.equal(JSON.stringify([...records]), beforeRecords);
});

test('natural Korean filename order places numbered episodes correctly regardless of analysis status', () => {
  const files = [file('여행10.mp4'), file('여행2.mp4'), file('여행1.mp4')];
  const records = new Map([[files[0].path, { status: 'completed' }]]);
  assert.deepEqual(orderedNames(files, records, 'name-asc'), ['여행1.mp4', '여행2.mp4', '여행10.mp4']);
  assert.deepEqual(orderedNames(files, records, 'name-desc'), ['여행10.mp4', '여행2.mp4', '여행1.mp4']);
});

test('recent analysis uses saved timestamps, falls back from invalid saved dates, and leaves unanalysed files last', () => {
  const files = [file('미분석.mp4'), file('날짜없음.mp4'), file('새분석.mp4'), file('수정함.mp4'), file('오래된분석.mp4')];
  const records = new Map([
    [files[1].path, { status: 'completed', savedAt: 'invalid', analyzedAt: '' }],
    [files[2].path, { status: 'completed', savedAt: 'invalid', analyzedAt: '2026-10-14T02:00:00Z' }],
    [files[3].path, { status: 'partial', savedAt: '2026-10-14T12:00:00+09:00', analyzedAt: '2026-10-12T00:00:00Z' }],
    [files[4].path, { status: 'failed', analyzedAt: '2026-10-13T00:00:00Z' }]
  ]);
  assert.deepEqual(orderedNames(files, records, 'recent-analysis'), ['수정함.mp4', '새분석.mp4', '오래된분석.mp4', '날짜없음.mp4', '미분석.mp4']);
});

test('path sorting groups drives and naturally orders folders despite slash and case differences', () => {
  const files = [file('영상.mp4', 'E:\\폴더2\\영상.mp4'), file('영상.mp4', 'd:/폴더10/영상.mp4'), file('영상.mp4', 'D:\\폴더2\\영상.mp4'), file('영상.mp4', 'C:\\폴더20\\영상.mp4')];
  assert.deepEqual(sortFiles(files, () => null, 'path-asc').map(item => item.path), [files[3].path, files[2].path, files[1].path, files[0].path]);
});

test('equal status, missing dates and duplicate filenames have deterministic path and ID ties', () => {
  const files = [file('같은영상.mp4', 'E:\\같은영상.mp4'), file('같은영상.mp4', 'D:\\같은영상.mp4', { id: 'b' }), file('같은영상.mp4', 'D:\\같은영상.mp4', { id: 'a' })];
  const expected = [files[2], files[1], files[0]];
  const record = { status: 'completed', savedAt: 'invalid' };
  for (const order of ['completed-first', 'recent-analysis', 'name-asc', 'name-desc', 'path-asc']) {
    assert.deepEqual(sortFiles(files, () => record, order), expected);
    assert.deepEqual(sortFiles(files.slice().reverse(), () => record, order), expected);
  }
});

test('unknown or absent stored ordering falls back to completed-first safely', () => {
  assert.equal(DEFAULT_ORDER, 'completed-first');
  for (const value of [undefined, null, '', 'obsolete', '__proto__', {}, 1]) assert.equal(normalizeOrder(value), DEFAULT_ORDER);
  for (const value of ['completed-first', 'recent-analysis', 'name-asc', 'name-desc', 'path-asc']) assert.equal(normalizeOrder(value), value);
});
