const { sendDiagnosticReports } = require('./lan-analysis');

// Telemetry has its own durable outbox. Sending a report never repeats an
// analysis/translation request and cannot change an analysis result.
function createDiagnosticReporter({ store, getConnection, sendReports = sendDiagnosticReports,
  intervalMs = 30000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = Date.now } = {}) {
  if (!store || typeof getConnection !== 'function') throw new TypeError('Diagnostics store and connection reader are required');
  let timer, operation, stopped = false;
  let lastError = '', lastAttemptAt = null, lastSuccessAt = null;

  async function deliver(preferred) {
    if (stopped) return;
    const connection = preferred?.remoteUrl && preferred?.connectionCode ? preferred : await getConnection();
    if (!connection?.remoteUrl || !connection?.connectionCode) return;
    const pending = await store.pendingReports(connection.remoteUrl, { limit: 50 });
    if (!pending.length) return;
    const identity = await store.getIdentity();
    const reports = pending.slice();
    while (reports.length > 1 && Buffer.byteLength(JSON.stringify({ ...identity, reports }), 'utf8') > 60 * 1024) reports.pop();
    lastAttemptAt = new Date(now()).toISOString();
    const sent = await sendReports({ ...connection, ...identity, reports, signal: AbortSignal.timeout(5000) });
    if (!sent?.ok) {
      lastError = '연결 PC의 진단 기록 전송을 완료하지 못했습니다. 기록은 이 PC에 보관되어 다음 연결 때 다시 전송합니다.';
      return;
    }
    const expected = new Set(reports.map(report => report.reportId));
    const accepted = (sent.acceptedReportIds || []).filter(id => expected.has(id));
    if (accepted.length) await store.ackReports(accepted);
    lastError = accepted.length === reports.length ? '' : '일부 진단 기록의 수신 확인이 없어 이 PC에 보관했습니다.';
    lastSuccessAt = new Date(now()).toISOString();
  }

  function flush(connection) {
    if (stopped) return Promise.resolve();
    if (operation) return operation;
    operation = Promise.resolve().then(() => deliver(connection)).catch(() => {
      lastError = '진단 기록을 전송하지 못했습니다. 이 PC의 보관 기록은 유지됩니다.';
    }).finally(() => { operation = null; });
    return operation;
  }

  async function enqueue(event, remoteUrl, connection) {
    // Queue first, including while shutting down. The next application run can
    // deliver the report even if this connection or process disappears.
    await store.enqueueReport(event, remoteUrl);
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

  function getStatus() { return { running: Boolean(timer), busy: Boolean(operation), lastError, lastAttemptAt, lastSuccessAt }; }
  return { enqueue, flush, start, stop, getStatus };
}

module.exports = { createDiagnosticReporter };
