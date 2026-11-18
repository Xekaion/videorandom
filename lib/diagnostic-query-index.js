// Diagnostic events are immutable after their durable publication. Build the
// ordered read view once per publication instead of sorting the entire history
// for every UI poll. The store invalidates this view only when its Map changes.
function createDiagnosticQueryIndex({ events, projectEvent } = {}) {
  if (!(events instanceof Map) || typeof projectEvent !== 'function') throw new TypeError('Diagnostic query inputs are required');
  let cached;
  const snapshot = () => {
    if (cached) return cached;
    const ordered = [...events.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
    const clients = new Map(), positions = new Map();
    let errors = 0, warnings = 0;
    ordered.forEach((event, index) => {
      positions.set(event.id, index);
      if (event.level === 'error') errors++;
      if (event.level === 'warning') warnings++;
      if (event.clientId && !clients.has(event.clientId)) clients.set(event.clientId,
        { clientId: event.clientId, clientName: event.clientName || '', lastSeenAt: event.recordedAt });
    });
    cached = { ordered, positions, clients: [...clients.values()], stats: { total: ordered.length, errors, warnings, clients: clients.size } };
    return cached;
  };
  function query({ q = '', level, clientId, jobId, before, limit = 100 } = {}) {
    const view = snapshot();
    limit = Number.isSafeInteger(Number(limit)) ? Math.min(200, Math.max(1, Number(limit))) : 100;
    const search = String(q).slice(0, 500).toLowerCase();
    const beforePosition = before ? view.positions.get(before) : undefined;
    const start = before ? beforePosition === undefined ? view.ordered.length : beforePosition + 1 : 0;
    const selected = [];
    // Global client/stats metadata is already captured. Once a further match
    // proves hasMore, later rows cannot change this page or its next cursor.
    for (let index = start; index < view.ordered.length && selected.length <= limit; index++) {
      const event = view.ordered[index];
      if (level && event.level !== level || clientId && event.clientId !== clientId
        || jobId && ![event.jobId, event.clientJobId, event.serverJobId].includes(jobId)
        || search && ![event.videoName, event.clientName, event.clientId, event.jobId, event.clientJobId,
          event.serverJobId, event.code, event.message, event.stage].some(value => value?.toLowerCase().includes(search))) continue;
      selected.push(event);
    }
    const hasMore = selected.length > limit;
    if (hasMore) selected.pop();
    return { schemaVersion: 1, events: selected.map(projectEvent), hasMore,
      nextCursor: hasMore ? selected.at(-1).id : null,
      clients: view.clients.map(client => ({ ...client })), stats: { ...view.stats } };
  }
  function* exportEvents() {
    const { ordered } = snapshot();
    // The descending time/ID comparator is exactly the reverse of the export
    // comparator; IDs are unique. Hold this stable view across async yields.
    for (let index = ordered.length - 1; index >= 0; index--) yield projectEvent(ordered[index]);
  }
  return { query, exportEvents, invalidate() { cached = undefined; } };
}

module.exports = { createDiagnosticQueryIndex };
