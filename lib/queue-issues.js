const path = require('path');
const crypto = require('crypto');
const { classifyQueueRecord } = require('./queue-outcome');
const { subtitleCompletion } = require('./record-health');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.wmv', '.avi', '.mpg', '.mpeg', '.asf', '.flv', '.webm', '.mov', '.3gp', '.ts', '.m4v', '.tp', '.m2ts']);
const SAFE_ID = /^[a-f0-9]{16,64}$/;

// Queue history is derived from durable result markers, independently of the
// catalog's best result for each path. Never copy dialogue or provider errors.
function queueIssueKey(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.recordId, item.code, item.recordedAt])).digest('hex');
}

function queueIssues(records, { dismissed = new Set(), limit = 20 } = {}) {
  const items = [], seen = new Set();
  for (const record of records || []) {
    if (!record || typeof record.id !== 'string' || !SAFE_ID.test(record.id) || seen.has(record.id)
      || typeof record.path !== 'string' || record.path.length > 32768 || /[\x00-\x1f\x7f]/.test(record.path)
      || !(path.isAbsolute(record.path) || path.win32.isAbsolute(record.path))
      || !VIDEO_EXTENSIONS.has(path.extname(record.path).toLowerCase())) continue;
    const marker = record.queueOutcome;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || Object.keys(marker).some(key => !['version', 'action', 'code', 'recordedAt'].includes(key))
      || marker.version !== 1 || marker.action !== 'skipped'
      || typeof marker.code !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(marker.code)
      || typeof marker.recordedAt !== 'string' || marker.recordedAt.length > 40
      || !Number.isFinite(Date.parse(marker.recordedAt))) continue;
    let outcome;
    try { outcome = classifyQueueRecord(record, { catalogSaved: true }); }
    catch (_) { continue; }
    if (!outcome?.canContinue || outcome.scope !== 'file' || outcome.code !== marker.code) continue;
    const name = record.path.replace(/\\/g, '/').split('/').at(-1).slice(0, 260);
    if (!name) continue;
    const item = { recordId: record.id, name, path: record.path, code: outcome.code, reason: outcome.reason,
      recordedAt: new Date(marker.recordedAt).toISOString() };
    try {
      const completion = subtitleCompletion(record);
      if (Number.isSafeInteger(completion?.totalCues) && completion.totalCues >= 0 && completion.totalCues <= 50000
        && Number.isSafeInteger(completion.completedCues) && completion.completedCues >= 0 && completion.completedCues <= completion.totalCues) {
        item.totalCues = completion.totalCues; item.completedCues = completion.completedCues;
      }
    } catch (_) { /* Broken optional counters never hide the saved attempt. */ }
    seen.add(record.id);
    if (!dismissed.has(queueIssueKey(item))) items.push(item);
  }
  items.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.recordId.localeCompare(b.recordId));
  return { total: items.length, items: items.slice(0, limit) };
}

module.exports = { queueIssues, queueIssueKey };
