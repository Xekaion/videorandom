const { sendDiagnosticReports } = require('./lan-analysis');
const { createDiagnosticFailureHealth } = require('./diagnostics');

// Telemetry has its own durable outbox. Sending a report never repeats an
// analysis/translation request and cannot change an analysis result.
function createDiagnosticReporter({ store, getConnection, sendReports = sendDiagnosticReports,
  intervalMs = 30000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = Date.now } = {}) {
  if (!store || typeof getConnection !== 'function') throw new TypeError('Diagnostics store and connection reader are required');
  let timer, operation, stopped = false;
  let lastAttemptAt = null, lastSuccessAt = null;
  const health = createDiagnosticFailureHealth({ now });
  async function observe(operation, action) {
    try { const result = await action(); health.recover(operation); return result; }
    catch (error) { health.fail(operation, error); throw error; }
  }

  async function deliver(preferred) {
    if (stopped) return;
    const connection = preferred?.remoteUrl && preferred?.connectionCode ? preferred : await observe('connection', getConnection);
    if (!connection?.remoteUrl || !connection?.connectionCode) return;
    const pending = await observe('pending', () => store.pendingReports(connection.remoteUrl, { limit: 50 }));
    if (!pending.length) return;
    const identity = await observe('identity', () => store.getIdentity());
    const reports = pending.slice();
    while (reports.length > 1 && Buffer.byteLength(JSON.stringify({ ...identity, reports }), 'utf8') > 60 * 1024) reports.pop();
    lastAttemptAt = new Date(now()).toISOString();
    let sent;
    try { sent = await sendReports({ ...connection, ...identity, reports, signal: AbortSignal.timeout(5000) }); }
    catch (error) { health.fail('send', error); return; }
    if (!sent?.ok) {
      health.fail('send', sent?.error);
      return;
    }
    health.recover('send');
    const expected = new Set(reports.map(report => report.reportId));
    const accepted = (sent.acceptedReportIds || []).filter(id => expected.has(id));
    if (accepted.length) await observe('ack', () => store.ackReports(accepted));
    if (accepted.length === reports.length) health.recover('acknowledgement');
    else health.fail('acknowledgement');
    lastSuccessAt = new Date(now()).toISOString();
  }

  function flush(connection) {
    if (stopped) return Promise.resolve();
    if (operation) return operation;
    operation = Promise.resolve().then(() => deliver(connection)).catch(() => {}).finally(() => { operation = null; });
    return operation;
  }

  async function enqueue(event, remoteUrl, connection) {
    // Queue first, including while shutting down. The next application run can
    // deliver the report even if this connection or process disappears.
    await observe('enqueue', () => store.enqueueReport(event, remoteUrl));
    if (!stopped) void flush(connection);
  }

  function start() {
    if (timer) return;
    stopped = false;
    timer = setIntervalImpl(() => { void flush(); }, intervalMs);
    timer.unref?.();
    void flush();
  }

  async function stop() {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    if (operation) await operation;
    await store.flush();
  }

  function getStatus() { return { running: Boolean(timer), busy: Boolean(operation), lastError: health.lastError(), lastAttemptAt, lastSuccessAt,
    deliveryHealth: health.snapshot() }; }
  return { enqueue, flush, start, stop, getStatus };
}

module.exports = { createDiagnosticReporter };
