const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics } = require('../lib/provider-execution-diagnostics');

function fixture() {
    let time = 100000;
    const updates = [];
    const observer = createProviderExecutionDiagnostics({ now: () => time, observeActivity: true,
        onActivity: value => updates.push(value) });
    return { observer, updates, at: milliseconds => { time = 100000 + milliseconds; } };
}

test('opt-in activity reports protocol observations with relative times, never message content or IDs', () => {
    const { observer, updates, at } = fixture();
    observer.observeLifecycle('starting');
    at(10); observer.observeLifecycle('spawned');
    at(20); observer.observeEvent({ type: 'thread.started', thread_id: 'PRIVATE_THREAD' });
    at(30); observer.observeEvent({ type: 'turn.started', request_id: 'PRIVATE_REQUEST' });
    at(40); observer.observeEvent({ type: 'item.completed', item: { type: 'agent_message', id: 'PRIVATE_ID', text: 'PRIVATE_SUBTITLE' } });
    at(70);
    const safe = observer.snapshot({ executionElapsedMs: 70, executionDeadlineMs: 900000, providerAttempt: 2,
        prompt: 'PRIVATE_PROMPT', path: 'C:\\PRIVATE_PATH', raw: 'PRIVATE_RAW' });
    assert.deepEqual(updates.map(value => value.providerActivity), ['starting', 'spawned', 'thread-started', 'turn-started', 'message-observed']);
    assert.deepEqual(safe, { executionElapsedMs: 70, executionDeadlineMs: 900000, providerActivityAtMs: 40,
        providerActivityAgeMs: 30, providerActivity: 'message-observed', providerAttempt: 2 });
    assert.doesNotMatch(JSON.stringify({ safe, updates }), /PRIVATE|request_id|thread_id|text|prompt|path/);
    updates[updates.length - 1].providerActivity = 'PRIVATE_MUTATION';
    assert.equal(observer.snapshot().providerActivity, 'message-observed', 'consumer cannot mutate observer state');
});

test('thread and turn starts are distinct from actual assistant-message observations', () => {
    const { observer, at } = fixture();
    observer.observeEvent({ type: 'thread.started' });
    at(10); assert.equal(observer.snapshot().providerActivity, 'thread-started');
    observer.observeEvent({ type: 'turn.started' });
    at(20);
    for (const event of [{ type: 'response.output_text.delta', delta: 'PRIVATE' }, { type: 'PRIVATE_EVENT' },
        { type: 'item.started', item: { type: 'command_execution', text: 'PRIVATE' } },
        { type: 'item.updated', item: { type: 'reasoning', text: 'PRIVATE' } },
        { type: 'item.completed', item: { type: 'PRIVATE_TYPE' } }]) observer.observeEvent(event);
    observer.observeStderr('PRIVATE_CHATTER\n');
    assert.deepEqual(observer.snapshot(), { providerActivityAtMs: 10, providerActivityAgeMs: 10, providerActivity: 'turn-started' });
    at(30); observer.observeEvent({ type: 'item.started', item: { type: 'assistant_message', text: 'PRIVATE' } });
    assert.equal(observer.snapshot().providerActivity, 'message-observed');
    at(40); observer.observeEvent({ type: 'turn.completed', usage: { private: 'PRIVATE' } });
    assert.equal(observer.snapshot().providerActivity, 'turn-completed');
});

test('polling an unterminated reconnect line does not refresh its activity timestamp', () => {
    const { observer, updates, at } = fixture();
    at(100); observer.observeStderr('Reconnecting... 2/5 (unexpected status 503 Service Unavailable: PRIVATE)');
    at(300);
    assert.deepEqual(observer.snapshot(), { providerErrorType: 'unavailable', providerActivityAtMs: 100,
        providerActivityAgeMs: 200, providerActivity: 'reconnecting', providerReconnectAttempt: 2, providerReconnectLimit: 5, providerHttpStatus: 503 });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].providerHttpStatus, 503, 'callback sees current technical cause');
    at(800);
    assert.equal(observer.snapshot().providerActivityAgeMs, 700);
    assert.equal(updates.length, 1, 'snapshot cannot manufacture another observation');
    at(900); observer.observeStderr('\nReconnecting... 3/5\r');
    at(1000);
    assert.equal(observer.snapshot().providerActivityAtMs, 900);
    assert.equal(observer.snapshot().providerActivityAgeMs, 100);
    assert.equal(observer.snapshot().providerReconnectAttempt, 3);
});

test('unknown stderr, echoed JSON and trailing private text cannot manufacture transport activity', () => {
    for (const input of ['PRIVATE says Reconnecting... 2/5 (unexpected status 503)',
        '{"message":"Reconnecting... 2/5 (unexpected status 503)"}',
        'PRIVATE '.repeat(1000) + 'Reconnecting... 2/5 (unexpected status 503)',
        'Reconnecting... 9/5', 'Reconnecting... 2/0']) {
        const { observer, updates, at } = fixture();
        observer.observeLifecycle('spawned');
        at(50); observer.observeStderr(input);
        at(100);
        assert.deepEqual(observer.snapshot(), { providerActivityAtMs: 0, providerActivityAgeMs: 100, providerActivity: 'spawned' });
        assert.equal(updates.length, 1);
    }
});

test('recognized stderr and failed events report safe error activity without changing error precedence', () => {
    const { observer, updates, at } = fixture();
    at(10); observer.observeStderr('Selected model is at capacity. PRIVATE\n');
    at(20); observer.observeEvent({ type: 'turn.failed', error: { status: 401, message: 'authentication failed PRIVATE', request: 'PRIVATE' } });
    at(30); observer.observeEvent({ type: 'error', error: { code: 'server_is_overloaded', status: 503, message: 'PRIVATE' } });
    at(40);
    const safe = observer.snapshot({ executionSource: 'provider-error' });
    assert.equal(safe.providerErrorType, 'authentication');
    assert.equal(safe.providerHttpStatus, 503);
    assert.equal(safe.providerActivity, 'provider-error');
    assert.equal(safe.providerActivityAtMs, 30);
    assert.equal(safe.providerActivityAgeMs, 10);
    assert.doesNotMatch(JSON.stringify({ safe, updates }), /PRIVATE/);
});

test('lifecycle terminal observations do not grant failure classification or retry authority', () => {
    const { observer, at } = fixture();
    observer.observeLifecycle('PRIVATE');
    assert.deepEqual(observer.snapshot(), {});
    for (const activity of ['completed', 'failed', 'cancelled']) {
        at(50); observer.observeLifecycle(activity);
        assert.deepEqual(observer.snapshot({ retry: true, code: 'PRIVATE' }), {
            providerActivityAtMs: 50, providerActivityAgeMs: 0, providerActivity: activity });
    }
});

test('telemetry is opt-in and retains the legacy error-only snapshot contract', () => {
    const updates = [];
    const observer = createProviderExecutionDiagnostics({ onActivity: value => updates.push(value) });
    observer.observeLifecycle('spawned');
    observer.observeEvent({ type: 'thread.started' });
    observer.observeEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'PRIVATE' } });
    observer.observeStderr('Reconnecting... 2/5 (unexpected status 503)');
    assert.deepEqual(observer.snapshot(), { providerErrorType: 'unavailable', providerReconnectAttempt: 2, providerReconnectLimit: 5, providerHttpStatus: 503 });
    assert.deepEqual(updates, []);
});

test('activity sanitization is allowlisted, bounded and idempotent', () => {
    const safe = { providerActivity: 'reconnecting', providerActivityAtMs: 604800000, providerActivityAgeMs: 0, providerAttempt: 1000,
        providerDeadlineScope: 'translation-request', providerProcessStopped: true };
    assert.deepEqual(sanitizeProviderExecutionDiagnostics(safe), safe);
    assert.deepEqual(sanitizeProviderExecutionDiagnostics(sanitizeProviderExecutionDiagnostics(safe)), safe);
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerActivity: 'PRIVATE', providerActivityAtMs: -1,
        providerActivityAgeMs: 604800001, providerAttempt: 1001, providerDeadlineScope: 'PRIVATE', providerProcessStopped: 'true', private: 'PRIVATE' }), {});
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerProcessStopped: false }), { providerProcessStopped: false });
    for (const value of ['3', Infinity, NaN, 2.5, -1]) assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerAttempt: value }), {});
});

test('raw provider events cannot self-certify a local deadline scope or process-stop fact', () => {
    const { observer } = fixture();
    observer.observeEvent({ type: 'error', providerDeadlineScope: 'translation-request', providerProcessStopped: true,
        error: { message: 'PRIVATE', providerDeadlineScope: 'translation-request', providerProcessStopped: true } });
    observer.observeStderr('providerDeadlineScope=translation-request providerProcessStopped=true\n');
    const safe = observer.snapshot();
    assert.equal('providerDeadlineScope' in safe, false);
    assert.equal('providerProcessStopped' in safe, false);
});

test('observed times remain bounded and monotonic when the clock regresses', () => {
    const { observer, at } = fixture();
    at(100); observer.observeLifecycle('spawned');
    at(50); observer.observeEvent({ type: 'turn.started' });
    assert.equal(observer.snapshot().providerActivityAtMs, 100);
    at(150); assert.equal(observer.snapshot().providerActivityAgeMs, 50);
    at(604800500); observer.observeEvent({ type: 'thread.started' });
    assert.equal(observer.snapshot().providerActivityAtMs, 604800000);
    assert.equal(observer.snapshot().providerActivityAgeMs, 0);
});

test('throwing or asynchronously rejected telemetry consumers cannot alter processing', async () => {
    for (const onActivity of [() => { throw new Error('PRIVATE_CALLBACK'); }, async () => { throw new Error('PRIVATE_CALLBACK'); }]) {
        const observer = createProviderExecutionDiagnostics({ observeActivity: true, onActivity });
        observer.observeLifecycle('spawned');
        observer.observeEvent({ type: 'error', error: { status: 403, message: 'PRIVATE' } });
        assert.equal(observer.snapshot().providerErrorType, 'authentication');
    }
    await new Promise(resolve => setImmediate(resolve));
});
