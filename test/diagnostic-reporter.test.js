const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticReporter } = require('../lib/diagnostic-reporter');

function fixture(sendReports) {
  const pending = new Map(), order = [], calls = [];
  const connection = { remoteUrl: 'http://127.0.0.1:3001', connectionCode: 'never-persist-this-secret' };
  const store = {
    async enqueueReport(event, remoteUrl) { order.push('persist'); pending.set(event.id, { reportId: event.id, event, remoteUrl }); },
    async pendingReports(remoteUrl, { limit }) { return [...pending.values()].filter(item => item.remoteUrl === remoteUrl).slice(0, limit); },
    async getIdentity() { return { clientId: 'owned-client', clientName: 'Owned PC', clientVersion: '1.9.2' }; },
    async ackReports(ids) { for (const id of ids) pending.delete(id); },
    async flush() { order.push('flush'); }
  };
  const timers = [], cleared = [];
  const create = overrides => createDiagnosticReporter({ store, getConnection: async () => connection,
    setIntervalImpl(callback, interval) { const timer = { callback, interval, unref() {} }; timers.push(timer); return timer; },
    clearIntervalImpl(timer) { cleared.push(timer); },
    sendReports: async options => { order.push('send'); calls.push(options); return sendReports(options); }, ...overrides });
  return { pending, order, calls, store, create, connection, timers, cleared };
}

test('offline reports remain durable and a later reporter sends only telemetry before acknowledging', async () => {
  let online = false;
  const f = fixture(async options => online ? { ok: true, acceptedReportIds: options.reports.map(r => r.reportId) } : { ok: false });
  const first = f.create();
  await first.enqueue({ id: 'report-1', code: 'NETWORK_UNREACHABLE' }, f.connection.remoteUrl);
  await first.flush();
  assert.deepEqual(f.order.slice(0, 2), ['persist', 'send']);
  assert.equal(f.pending.size, 1);
  assert.equal(JSON.stringify([...f.pending.values()]).includes(f.connection.connectionCode), false);
  assert.match(first.getStatus().lastError, /보관/);
  await first.stop();
  online = true;
  const second = f.create();
  await second.flush();
  assert.equal(f.pending.size, 0);
  assert.equal(second.getStatus().lastError, '');
  assert.equal(f.calls.at(-1).reports[0].event.code, 'NETWORK_UNREACHABLE');
  assert.equal(f.calls.at(-1).clientName, 'Owned PC');
  await second.stop();
});

test('overlapping flushes share one send and new reports are preserved for the following send', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const sending = new Promise(resolve => { entered = resolve; });
  const f = fixture(async options => { entered(); await gate; return { ok: true, acceptedReportIds: options.reports.map(r => r.reportId) }; });
  const reporter = f.create();
  try {
    await reporter.enqueue({ id: 'first' }, f.connection.remoteUrl);
    const first = reporter.flush();
    assert.equal(first, reporter.flush());
    await sending;
    await reporter.enqueue({ id: 'second' }, f.connection.remoteUrl);
    release();
    await first;
    assert.deepEqual([...f.pending.keys()], ['second']);
    await reporter.flush();
    assert.equal(f.calls.length, 2);
    assert.equal(f.pending.size, 0);
  } finally { release(); await reporter.stop(); }
});

test('payloads are bounded and an acknowledgement cannot remove an unsent report', async () => {
  const f = fixture(async options => ({ ok: true, acceptedReportIds: [...options.reports.map(r => r.reportId), 'unsent'] }));
  for (let i = 0; i < 51; i++) f.pending.set(String(i), { reportId: String(i), remoteUrl: f.connection.remoteUrl,
    event: { id: String(i), videoName: '가'.repeat(800) } });
  f.pending.set('unsent', { reportId: 'unsent', remoteUrl: f.connection.remoteUrl, event: { id: 'unsent' } });
  const reporter = f.create();
  await reporter.flush();
  assert.ok(f.calls[0].reports.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify({ clientId: 'owned-client', clientName: 'Owned PC', clientVersion: '1.9.2', reports: f.calls[0].reports })) <= 60 * 1024);
  assert.equal(f.pending.has('unsent'), true);
  assert.equal(f.pending.size, 52 - f.calls[0].reports.length);
  await reporter.stop();
});

test('idle polling makes no network request and stopping clears the timer without dropping later queued reports', async () => {
  const f = fixture(async () => { throw new Error('No pending reports should be sent'); });
  const reporter = f.create();
  reporter.start();
  await reporter.flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers[0].interval, 30000);
  await reporter.stop();
  await reporter.enqueue({ id: 'after-stop' }, f.connection.remoteUrl);
  assert.equal(f.pending.size, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cleared.length, 1);
});

test('connection or transport errors are diagnostic failures and never delete the pending event', async () => {
  const f = fixture(async () => { throw new Error('A transport error containing private values'); });
  const reporter = f.create();
  await reporter.enqueue({ id: 'failed' }, f.connection.remoteUrl);
  await reporter.flush();
  assert.equal(f.pending.size, 1);
  assert.match(reporter.getStatus().lastError, /보관/);
  assert.equal(reporter.getStatus().lastError.includes('private'), false);
  await reporter.stop();
});
