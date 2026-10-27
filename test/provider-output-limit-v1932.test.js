'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics } = require('../lib/provider-execution-diagnostics');
const { classifyDiagnosticError, classifyAnalysisFailure, sanitizeDiagnosticEvent } = require('../lib/diagnostics');
const { isProviderCapacityError } = require('../lib/provider-capacity-recovery');

// All fixtures are synthetic technical records. No CLI, model, network, user
// media, account configuration or persisted analysis data is accessed here.
const marker = 'incomplete response returned, reason: max_output_tokens';
const code = 'PROVIDER_OUTPUT_LIMIT';
const evidence = { executionSource: 'provider-error', providerErrorType: 'output-limit' };

for (const type of ['turn.failed', 'error']) {
    for (const field of ['error.message', 'message']) test(`exact ${type} ${field} identifies a request output limit`, () => {
        const observer = createProviderExecutionDiagnostics();
        observer.observeEvent(field === 'message' ? { type, message: marker } : { type, error: { message: marker } });
        const info = observer.snapshot({ executionSource: 'provider-error' });
        assert.deepEqual(info, evidence);
        const failure = classifyAnalysisFailure(Object.assign(new Error('Codex 요약 실패: ' + marker), info));
        assert.equal(failure.code, code);
        assert.equal(failure.providerErrorType, 'output-limit');
        assert.equal(isProviderCapacityError({ ...failure, ...info }), false, 'output truncation does not authorize capacity retries');
    });
}

for (const prefix of ['', 'error: ', '\x1b[31merror: \x1b[0m']) test(`exact stderr output-limit marker is recognized after CLI prefix ${JSON.stringify(prefix)}`, () => {
    const observer = createProviderExecutionDiagnostics();
    const bytes = Buffer.from(prefix + marker + '\r\n');
    for (let offset = 0; offset < bytes.length; offset++) observer.observeStderr(bytes.subarray(offset, offset + 1));
    assert.deepEqual(observer.snapshot({ executionSource: 'process-exit' }), {
        executionSource: 'process-exit', providerErrorType: 'output-limit'
    });
    assert.equal(classifyAnalysisFailure({ message: 'Synthetic command exit', ...observer.snapshot({ executionSource: 'process-exit' }) }).code, code);
});

for (const prefix of ['', 'Codex 요약 실패: ', 'Codex 자막 번역 실패: ']) test(`legacy exact error ${JSON.stringify(prefix)} has a distinct output-limit diagnostic`, () => {
    const classified = classifyDiagnosticError(prefix + marker);
    assert.equal(classified.code, code);
    assert.notEqual(classified.code, 'PROVIDER_QUOTA');
    assert.equal(classifyAnalysisFailure(new Error(prefix + marker)).code, code);
    assert.doesNotMatch(classified.message, /max_output_tokens|PRIVATE_/);
});

for (const value of [
    'Synthetic prompt: ' + marker,
    JSON.stringify({ message: marker }),
    JSON.stringify({ error: { message: marker } }),
    marker + ' PRIVATE_TRAILING_PAYLOAD',
    marker + ': {"prompt":"PRIVATE_PROMPT"}',
    marker.replace('max_output_tokens', 'max_output_tokens_extra'),
    marker.replace('max_output_tokens', 'max_input_tokens'),
    marker.replace('max_output_tokens', 'content_filter'),
    'reason: max_output_tokens',
    'max_output_tokens',
    'incomplete response returned, reason: "max_output_tokens"'
]) test(`arbitrary or noncanonical text is not output-limit authority: ${JSON.stringify(value)}`, () => {
    const observer = createProviderExecutionDiagnostics();
    observer.observeStderr(value + '\n');
    observer.observeEvent({ type: 'turn.failed', error: { message: value } });
    assert.notEqual(observer.snapshot().providerErrorType, 'output-limit');
    assert.notEqual(classifyDiagnosticError(value).code, code);
    assert.notEqual(classifyAnalysisFailure(new Error('Codex 요약 실패: ' + value)).code, code);
});

for (const type of ['item.started', 'item.completed', 'turn.completed', 'response.output_text.delta', 'unknown'])
    test(`a ${type} output containing the marker cannot become a service failure`, () => {
        const observer = createProviderExecutionDiagnostics();
        observer.observeEvent({ type, message: marker, error: { message: marker }, item: { text: marker } });
        assert.deepEqual(observer.snapshot(), {});
    });

test('a discarded long physical line cannot acquire a new output-limit prefix', () => {
    const observer = createProviderExecutionDiagnostics();
    observer.observeStderr('PRIVATE_PROMPT '.repeat(1000) + marker + '\n');
    assert.deepEqual(observer.snapshot(), {});
    observer.observeStderr(marker + '\n');
    assert.deepEqual(observer.snapshot(), { providerErrorType: 'output-limit' });
});

const blockers = [
    ['authentication', 'HTTP status 401', 'PROVIDER_AUTH'],
    ['authentication', 'HTTP status 403', 'PROVIDER_AUTH'],
    ['quota', 'HTTP status 429', 'PROVIDER_QUOTA'],
    ['refusal', 'Request refused', 'PROVIDER_REFUSAL'],
    ['network', 'ECONNRESET', 'NETWORK_UNREACHABLE'],
    ['timeout', 'Request timed out', 'PROVIDER_TIMEOUT'],
    ['capacity', 'Selected model is at capacity.', 'PROVIDER_CAPACITY'],
    ['unavailable', 'HTTP status 503', 'PROVIDER_UNAVAILABLE'],
    ['unavailable', 'HTTP status 500', 'PROVIDER_UNAVAILABLE']
];
for (const [type, message, expected] of blockers) for (const order of ['before', 'after'])
    test(`${message} ${order} output limit keeps the shared cause`, () => {
        const observer = createProviderExecutionDiagnostics();
        if (order === 'before') observer.observeStderr(message + '\n');
        observer.observeEvent({ type: 'turn.failed', error: { message: marker } });
        if (order === 'after') observer.observeEvent({ type: 'error', error: { message } });
        const info = observer.snapshot({ executionSource: 'provider-error' });
        assert.equal(info.providerErrorType, type);
        assert.equal(classifyAnalysisFailure(Object.assign(new Error('Codex 요약 실패: ' + marker), info)).code, expected);
    });

const conflictingMetadata = [
    [{ name: 'AbortError' }, 'ANALYSIS_CANCELLED'],
    [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED'],
    [{ executionSource: 'local-deadline' }, 'PROVIDER_TIMEOUT'],
    [{ executionSource: 'process-error' }, 'PROVIDER_UNKNOWN'],
    [{ httpStatus: 401 }, 'PROVIDER_AUTH'],
    [{ providerHttpStatus: 403 }, 'PROVIDER_AUTH'],
    [{ providerHttpStatus: 429 }, 'PROVIDER_QUOTA'],
    [{ providerHttpStatus: 503 }, 'PROVIDER_UNAVAILABLE'],
    [{ providerSystemCode: 'ECONNRESET' }, 'NETWORK_UNREACHABLE'],
    [{ systemCode: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
    [{ systemCode: 'ENOSPC' }, 'STORAGE_WRITE_FAILED'],
    [{ refusalSource: 'execution-error' }, 'PROVIDER_REFUSAL'],
    [{ causeCode: 'PROVIDER_AUTH' }, 'PROVIDER_AUTH'],
    [{ cause: { code: 'PROVIDER_QUOTA' } }, 'PROVIDER_QUOTA'],
    [{ cause: { code: 'PROVIDER_REFUSAL' } }, 'PROVIDER_REFUSAL'],
    [{ cause: { code: 'PROVIDER_UNAVAILABLE' } }, 'PROVIDER_UNAVAILABLE']
];
for (const [extra, expected] of conflictingMetadata) test(`output-limit evidence cannot erase ${JSON.stringify(extra)}`, () => {
    const failure = { message: 'Codex 요약 실패: ' + marker, ...evidence, ...extra };
    assert.equal(classifyAnalysisFailure(failure).code, expected);
    assert.equal(classifyAnalysisFailure({ ...failure, code }).code, expected, 'a public code cannot outrank the actual shared cause');
});

for (const shared of ['PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_CAPACITY',
    'NETWORK_UNREACHABLE', 'STORAGE_WRITE_FAILED', 'LOCAL_DEPENDENCY_MISSING', 'ANALYSIS_BUSY'])
    test(`an explicit or retained ${shared} is never downgraded by an output-limit marker`, () => {
        const failure = { message: marker, ...evidence };
        assert.equal(classifyAnalysisFailure({ ...failure, code: shared }).code, shared);
        assert.equal(classifyAnalysisFailure({ ...failure, diagnostic: { code: shared } }).code, shared);
    });

for (const [cause, expected] of [
    [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'],
    [{ providerErrorType: 'quota' }, 'PROVIDER_QUOTA'],
    [{ providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'],
    [{ providerSystemCode: 'ECONNRESET' }, 'NETWORK_UNREACHABLE'],
    [{ httpStatus: 503 }, 'PROVIDER_UNAVAILABLE']
]) test(`a coded immediate output-cap cause retains competing ${expected} through storage`, () => {
    const value = { code, ...evidence, cause: { code, ...cause } };
    assert.equal(classifyDiagnosticError(value).code, expected);
    assert.equal(classifyAnalysisFailure(value).code, expected);
    assert.equal(sanitizeDiagnosticEvent(value).code, expected);
});

for (const [cause, expected] of [
    [{ providerErrorType: 'authentication' }, 'PROVIDER_AUTH'],
    [{ providerErrorType: 'quota' }, 'PROVIDER_QUOTA'],
    [{ providerErrorType: 'refusal' }, 'PROVIDER_REFUSAL'],
    [{ providerSystemCode: 'ECONNRESET' }, 'NETWORK_UNREACHABLE'],
    [{ status: 401 }, 'PROVIDER_AUTH'],
    [{ status: 503 }, 'PROVIDER_UNAVAILABLE'],
    [{ executionSource: 'cancelled' }, 'ANALYSIS_CANCELLED'],
    [{ executionSource: 'local-deadline' }, 'PROVIDER_TIMEOUT'],
    [{ executionSource: 'process-error' }, 'PROVIDER_UNKNOWN'],
    [{ message: 'Synthetic unexplained cause' }, 'PROVIDER_UNKNOWN'],
    [{ code, message: 'Synthetic unexplained coded cause' }, 'PROVIDER_UNKNOWN']
]) test(`an uncoded immediate cause cannot grant output-cap continuation ${expected}`, () => {
    const value = { code, ...evidence, cause };
    assert.equal(classifyDiagnosticError(value).code, expected);
    assert.equal(classifyAnalysisFailure(value).code, expected);
    assert.equal(sanitizeDiagnosticEvent(value).code, expected);
});

test('sanitizers retain only bounded technical output-limit information and fixed descriptions', () => {
    const input = { ...evidence, providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard',
        executionElapsedMs: 123, executionDeadlineMs: 900000, message: 'PRIVATE_ERROR', prompt: 'PRIVATE_PROMPT',
        transcript: 'PRIVATE_TRANSCRIPT', raw: 'PRIVATE_RAW', output: 'PRIVATE_OUTPUT', stack: 'PRIVATE_PATH',
        apiKey: 'PRIVATE_KEY', connectionCode: 'PRIVATE_CODE', guessedMaxOutputTokens: 999999 };
    const clean = sanitizeProviderExecutionDiagnostics(input);
    assert.deepEqual(clean, { ...evidence, providerRequestedModel: 'gpt-6-luna', providerReasoningEffort: 'low', providerServiceTier: 'standard',
        executionElapsedMs: 123, executionDeadlineMs: 900000 });
    assert.deepEqual(sanitizeProviderExecutionDiagnostics(JSON.parse(JSON.stringify(clean))), clean);
    const event = sanitizeDiagnosticEvent({ ...input, code, event: 'error', level: 'error', stage: 'summary' });
    assert.equal(event.code, code);
    assert.equal(event.providerErrorType, 'output-limit');
    assert.equal(event.stage, 'summary');
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_|max_output_tokens|999999/);
    assert.deepEqual(sanitizeDiagnosticEvent(JSON.parse(JSON.stringify(event))), event);
    for (const fake of ['output-limit PRIVATE', 'max_output_tokens', 'output_limit', '', null]) {
        assert.equal(sanitizeProviderExecutionDiagnostics({ providerErrorType: fake }).providerErrorType, undefined);
    }
});

test('arbitrary response envelopes cannot self-certify an output-limit diagnostic', () => {
    for (const envelope of [
        { output: { error: { message: marker } } },
        { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
        { error: { message: marker } },
        { item: { message: marker } }
    ]) {
        const observer = createProviderExecutionDiagnostics();
        observer.observeEvent(envelope);
        assert.deepEqual(observer.snapshot(), {});
        assert.notEqual(classifyAnalysisFailure(envelope).code, code);
    }
});
