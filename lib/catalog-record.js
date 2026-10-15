const { recordHealth } = require('./record-health');

// Lists and progress polling need metadata, not every spoken word and its
// diagnostics. The full saved record remains available through its detail API.
function catalogRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const result = { catalogView: 'summary' };
  for (const key of ['id', 'name', 'path', 'ext', 'size', 'duration', 'status', 'summary', 'plot', 'dialogueSummary',
    'analysisMode', 'analysisProvider', 'analyzedAt', 'savedAt', 'editedAt', 'repairOf', 'error']) {
    if (record[key] !== undefined) result[key] = record[key];
  }
  result.labels = Array.isArray(record.labels) ? record.labels : [];
  result.frames = (Array.isArray(record.frames) ? record.frames : []).slice(0, 3)
    .map(({ timestamp, filename, caption }) => ({ timestamp, filename, caption }));
  result.frameCount = Array.isArray(record.frames) ? record.frames.length : 0;
  result.transcriptCount = Array.isArray(record.transcript) ? record.transcript.length : 0;
  result.health = recordHealth(record);
  return result;
}

module.exports = { catalogRecord };
