/* Pure catalog ordering shared by the browser and its verification. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.videoCatalogSort = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_ORDER = 'completed-first';
  const ORDERS = ['completed-first', 'recent-analysis', 'name-asc', 'name-desc', 'path-asc'];
  const names = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
  const normalizeOrder = value => ORDERS.includes(value) ? value : DEFAULT_ORDER;
  const normalizedPath = value => String(value || '').replace(/\//g, '\\').toLowerCase();
  const plainCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  function savedTime(record) {
    for (const value of [record?.savedAt, record?.analyzedAt]) {
      if (!value) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
    return -Infinity;
  }

  function sortFiles(files, recordFor, order) {
    const selectedOrder = normalizeOrder(order);
    const entries = files.map(file => {
      const record = recordFor(file);
      return {
        file, name: String(file.name || file.path || ''), path: normalizedPath(file.path),
        id: String(file.id || record?.id || ''), time: savedTime(record), hasRecord: !!record,
        status: record?.status === 'completed' ? 0 : record?.status === 'partial' ? 1 : record?.status === 'failed' ? 3 : 2
      };
    });
    const compareName = (a, b) => names.compare(a.name, b.name);
    const comparePath = (a, b) => names.compare(a.path, b.path) || plainCompare(a.path, b.path) || plainCompare(a.id, b.id);
    const compareRecent = (a, b) => plainCompare(b.time, a.time);
    entries.sort((a, b) => {
      if (selectedOrder === 'name-asc') return compareName(a, b) || comparePath(a, b);
      if (selectedOrder === 'name-desc') return -compareName(a, b) || comparePath(a, b);
      if (selectedOrder === 'path-asc') return comparePath(a, b) || compareName(a, b);
      if (selectedOrder === 'recent-analysis') return Number(b.hasRecord) - Number(a.hasRecord) || compareRecent(a, b) || compareName(a, b) || comparePath(a, b);
      return a.status - b.status || compareRecent(a, b) || compareName(a, b) || comparePath(a, b);
    });
    return entries.map(entry => entry.file);
  }

  return { DEFAULT_ORDER, normalizeOrder, sortFiles };
});
