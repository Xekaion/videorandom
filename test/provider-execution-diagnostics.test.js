const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics } = require('../lib/provider-execution-diagnostics');

test('local command deadline is distinct from provider timeout without overwriting its cause', () => {
    const diagnostic = createProviderExecutionDiagnostics();
    diagnostic.observeStderr(Buffer.from('Reconnecting... 2/5 (unexpected status 503 Service Unavailable: PRIVATE_REASON)\n'));
    assert.deepEqual(diagnostic.snapshot({ executionSource: 'local-deadline', executionElapsedMs: 900014, executionDeadlineMs: 900000 }), {
        executionSource: 'local-deadline', providerErrorType: 'unavailable', executionElapsedMs: 900014, executionDeadlineMs: 900000,
        providerReconnectAttempt: 2, providerReconnectLimit: 5, providerHttpStatus: 503
    });
    const provider = createProviderExecutionDiagnostics();
    provider.observeEvent({ type: 'turn.failed', error: { message: 'The request timed out. PRIVATE_REASON' } });
    assert.deepEqual(provider.snapshot({ executionSource: 'provider-error' }), { executionSource: 'provider-error', providerErrorType: 'timeout' });
});

test('split UTF8, escaped error strings and terminal redraws preserve only safe markers', () => {
    const source = '\x1b[31mReconnecting... 2/5\x1b[0m (unexpected status 503 Service Unavailable)\rReconnecting... 3/5\n日本語 PRIVATE_TRANSCRIPT\\u0020PRIVATE_ESCAPED\n';
    const bytes = Buffer.from(source);
    const diagnostic = createProviderExecutionDiagnostics();
    for (let i = 0; i < bytes.length; i++) diagnostic.observeStderr(bytes.subarray(i, i + 1));
    diagnostic.observeEvent({ type: 'error', error: { message: 'unexpected status \\u0035\\u0030\\u0033 PRIVATE_ESCAPED' } });
    assert.deepEqual(diagnostic.snapshot(), { providerErrorType: 'unavailable', providerReconnectAttempt: 3, providerReconnectLimit: 5, providerHttpStatus: 503 });
    assert.doesNotMatch(JSON.stringify(diagnostic.snapshot()), /PRIVATE|日本語|\\u/);
});

test('only failed/error provider events are inspected and paths, prompts and credentials never escape', () => {
    const diagnostic = createProviderExecutionDiagnostics();
    for (const type of ['item.completed', 'turn.completed', 'response.output_text.delta', 'unknown']) {
        diagnostic.observeEvent({ type, message: 'unexpected status 401 PRIVATE_TRANSCRIPT', error: { message: 'request refused PRIVATE_PROMPT' } });
    }
    assert.deepEqual(diagnostic.snapshot(), {});
    diagnostic.observeEvent({ type: 'error', error: { message: 'HTTP/1.1 429 quota exceeded Authorization: Bearer sk-PRIVATE_SECRET C:\\PRIVATE_PATH',
        status_code: 429, request: { prompt: 'PRIVATE_PROMPT' } }, headers: { authorization: 'PRIVATE_SECRET' } });
    const safe = diagnostic.snapshot({ executionSource: 'provider-error', raw: 'PRIVATE_RAW', prompt: 'PRIVATE_PROMPT', stack: 'PRIVATE_PATH' });
    assert.deepEqual(safe, { executionSource: 'provider-error', providerErrorType: 'quota', providerHttpStatus: 429 });
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|Bearer|sk-/);
});

test('refusal marker remains informational and cannot replace caller error code or retry policy', () => {
    const diagnostic = createProviderExecutionDiagnostics();
    diagnostic.observeEvent({ type: 'turn.failed', error: { message: 'Request refused: PRIVATE_REASON' } });
    const original = { code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error' };
    const merged = { ...original, ...diagnostic.snapshot({ executionSource: 'provider-error', code: 'PROVIDER_TIMEOUT', retry: true }) };
    assert.deepEqual(merged, { code: 'PROVIDER_REFUSAL', refusalSource: 'execution-error', executionSource: 'provider-error', providerErrorType: 'refusal' });
    assert.equal('retry' in merged, false);
});

test('system connection refusal is network, while authentication and quota keep technical priority', () => {
    for (const [message, expected] of [['ECONNREFUSED private', 'network'], ['ETIMEDOUT request refused', 'timeout'],
        ['unexpected status 401 authentication failed request refused', 'authentication'], ['unexpected status 429 quota exceeded request refused', 'quota'],
        ['unexpected status 503 Service Unavailable request refused', 'unavailable']]) {
        const diagnostic = createProviderExecutionDiagnostics(); diagnostic.observeStderr(message);
        assert.equal(diagnostic.snapshot().providerErrorType, expected, message);
    }
});

test('long chunked output is bounded and unknown raw error text produces no stored message', () => {
    const diagnostic = createProviderExecutionDiagnostics();
    const source = 'PRIVATE_SECRET '.repeat(100000) + 'Reconnecting... 4/5 (unexpected status 502)';
    diagnostic.observeStderr(source);
    assert.deepEqual(diagnostic.snapshot(), {}, 'an embedded marker on an enormous echoed line is ignored');
    diagnostic.observeStderr('\nReconnecting... 4/5 (unexpected status 502)\n');
    diagnostic.observeStderr('\nPRIVATE_TAIL '.repeat(100));
    assert.deepEqual(diagnostic.snapshot(), { providerErrorType: 'unavailable', providerReconnectAttempt: 4, providerReconnectLimit: 5, providerHttpStatus: 502 });
    assert.deepEqual(createProviderExecutionDiagnostics().snapshot({ message: 'PRIVATE', error: new Error('PRIVATE') }), {});
});

test('arbitrary echoed prose and raw JSON cannot create transport markers', () => {
    for (const text of ['PRIVATE_PROMPT says Reconnecting... 4/5 (unexpected status 503)',
        '{"message":"Reconnecting... 4/5 (unexpected status 503)"}',
        'Translate this: HTTP status 401 authentication failed',
        'PRIVATE_TRANSCRIPT mentions ETIMEDOUT and request refused']) {
        const diagnostic = createProviderExecutionDiagnostics(); diagnostic.observeStderr(text);
        diagnostic.observeEvent({ type: 'error', error: { message: text } });
        assert.deepEqual(diagnostic.snapshot(), {}, text);
    }
});

test('an echoed payload after a known reconnect prefix cannot replace observed technical cause', () => {
    const diagnostic = createProviderExecutionDiagnostics();
    diagnostic.observeStderr('Reconnecting... 2/5 ({"prompt":"unexpected status 401 request refused"})\n');
    assert.deepEqual(diagnostic.snapshot(), { providerReconnectAttempt: 2, providerReconnectLimit: 5 });
    diagnostic.observeStderr('Reconnecting... 3/5 (unexpected status 503: {"prompt":"HTTP status 401 ETIMEDOUT request refused"})\n');
    assert.deepEqual(diagnostic.snapshot(), { providerReconnectAttempt: 3, providerReconnectLimit: 5, providerHttpStatus: 503, providerErrorType: 'unavailable' });
});

test('technical values are strictly sanitized, bounded and idempotent', () => {
    const safe = { executionSource: 'cancelled', executionElapsedMs: 0, executionDeadlineMs: 604800000,
        providerErrorType: 'network', providerSystemCode: 'ECONNRESET', providerReconnectAttempt: 1000, providerReconnectLimit: 1000, providerHttpStatus: 599 };
    assert.deepEqual(sanitizeProviderExecutionDiagnostics(safe), safe);
    assert.deepEqual(sanitizeProviderExecutionDiagnostics(sanitizeProviderExecutionDiagnostics(safe)), safe);
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ executionSource: 'local-deadline PRIVATE', executionElapsedMs: -1, executionDeadlineMs: 604800001,
        providerErrorType: 'PRIVATE', providerSystemCode: 'C:\\PRIVATE', providerReconnectAttempt: '2', providerReconnectLimit: Infinity, providerHttpStatus: 600 }), {});
    for (const bad of [undefined, null, [], 'PRIVATE', true]) assert.deepEqual(sanitizeProviderExecutionDiagnostics(bad), {});
});

test('bare arbitrary numbers and invalid reconnect counters are never promoted to technical metadata', () => {
    for (const input of ['PRIVATE_PIN=503 PRIVATE_TEXT 401 429', 'Reconnecting... 1001/1002 unexpected status 999',
        'Reconnecting... 8/5', 'Reconnecting... 2/0', 'HTTP status 503000 PRIVATE']) {
        const diagnostic = createProviderExecutionDiagnostics(); diagnostic.observeStderr(input);
        assert.deepEqual(diagnostic.snapshot(), {}, input);
    }
});

test('sanitized reconnect limits must be positive and inconsistent counter pairs are discarded', () => {
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectLimit: 0 }), {});
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectAttempt: 2, providerReconnectLimit: 0 }), {});
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectAttempt: 6, providerReconnectLimit: 5,
        providerHttpStatus: 503 }), { providerHttpStatus: 503 });
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectAttempt: 0, providerReconnectLimit: 5 }),
        { providerReconnectAttempt: 0, providerReconnectLimit: 5 });
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectAttempt: 2 }), { providerReconnectAttempt: 2 });
    assert.deepEqual(sanitizeProviderExecutionDiagnostics({ providerReconnectLimit: 5 }), { providerReconnectLimit: 5 });
});
