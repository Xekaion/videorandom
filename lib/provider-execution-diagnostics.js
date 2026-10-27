const { StringDecoder } = require('node:string_decoder');

// Provider output may contain a prompt, subtitle text, paths or credentials.
// Keep only these technical enums and bounded numbers, never an output excerpt.
const EXECUTION_SOURCES = new Set(['local-deadline', 'provider-error', 'process-exit', 'process-error', 'cancelled']);
const ERROR_TYPES = new Set(['timeout', 'authentication', 'quota', 'unavailable', 'network', 'refusal', 'capacity', 'output-limit']);
const CAPACITY_BLOCKERS = new Set(['authentication', 'quota', 'refusal', 'timeout', 'network']);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const NETWORK_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
const ACTIVITIES = new Set(['starting', 'spawned', 'thread-started', 'turn-started', 'message-observed', 'turn-completed',
    'reconnecting', 'provider-error', 'completed', 'failed', 'cancelled']);
const LIFECYCLE_ACTIVITIES = new Set(['starting', 'spawned', 'completed', 'failed', 'cancelled']);
const MAX_RECORD_LENGTH = 4096;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeProviderExecutionDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    if (EXECUTION_SOURCES.has(value.executionSource)) result.executionSource = value.executionSource;
    if (ERROR_TYPES.has(value.providerErrorType)) result.providerErrorType = value.providerErrorType;
    // This records the explicitly requested configuration, not an inference
    // about which model the remote service actually used.
    if (typeof value.providerRequestedModel === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{0,79}$/.test(value.providerRequestedModel)) result.providerRequestedModel = value.providerRequestedModel;
    if (REASONING_EFFORTS.has(value.providerReasoningEffort)) result.providerReasoningEffort = value.providerReasoningEffort;
    if (value.providerServiceTier === 'standard') result.providerServiceTier = value.providerServiceTier;
    if (Number.isSafeInteger(value.providerRetryAfterMs) && value.providerRetryAfterMs >= 0 && value.providerRetryAfterMs <= MAX_DURATION_MS) result.providerRetryAfterMs = value.providerRetryAfterMs;
    if (value.providerRetryAfterInvalid === true) result.providerRetryAfterInvalid = true;
    if (value.providerCapacityExhausted === true) result.providerCapacityExhausted = true;
    if (['request-limit', 'job-limit', 'deadline', 'retry-after-invalid', 'retry-after-limit'].includes(value.providerCapacityStopReason)) result.providerCapacityStopReason = value.providerCapacityStopReason;
    if (NETWORK_CODES.has(value.providerSystemCode)) result.providerSystemCode = value.providerSystemCode;
    for (const key of ['executionElapsedMs', 'executionDeadlineMs', 'providerActivityAtMs', 'providerActivityAgeMs']) {
        if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_DURATION_MS) result[key] = value[key];
    }
    if (ACTIVITIES.has(value.providerActivity)) result.providerActivity = value.providerActivity;
    if (Number.isSafeInteger(value.providerAttempt) && value.providerAttempt >= 1 && value.providerAttempt <= 1000) result.providerAttempt = value.providerAttempt;
    // These are caller-supplied execution facts. No output/event parser sets
    // them; a protocol event cannot certify that the child has stopped.
    if (value.providerDeadlineScope === 'translation-request') result.providerDeadlineScope = value.providerDeadlineScope;
    if (typeof value.providerProcessStopped === 'boolean') result.providerProcessStopped = value.providerProcessStopped;
    if (Number.isSafeInteger(value.providerReconnectAttempt) && value.providerReconnectAttempt >= 0 && value.providerReconnectAttempt <= 1000) result.providerReconnectAttempt = value.providerReconnectAttempt;
    if (Number.isSafeInteger(value.providerReconnectLimit) && value.providerReconnectLimit >= 1 && value.providerReconnectLimit <= 1000) result.providerReconnectLimit = value.providerReconnectLimit;
    if (result.providerReconnectAttempt !== undefined && value.providerReconnectLimit !== undefined
        && (result.providerReconnectLimit === undefined || result.providerReconnectAttempt > result.providerReconnectLimit)) {
        delete result.providerReconnectAttempt;
        delete result.providerReconnectLimit;
    }
    if (Number.isSafeInteger(value.providerHttpStatus) && value.providerHttpStatus >= 100 && value.providerHttpStatus <= 599) result.providerHttpStatus = value.providerHttpStatus;
    return result;
}

function createProviderExecutionDiagnostics({ now = Date.now, observeActivity = false, onActivity } = {}) {
    const state = {};
    const decoder = new StringDecoder('utf8');
    let pending = '', discardingLine = false;
    let capacitySeen = false, capacityBlocker, errorObservations = 0;
    // Relative times avoid storing wall-clock timestamps or any provider IDs.
    // The opt-in retains the exact legacy error-only snapshot contract.
    const startedAt = observeActivity ? now() : 0;
    let elapsed = 0, lastStderrAt = 0, stderrRevision = 0, inspectedPendingRevision = -1;

    function elapsedMs() {
        const current = now() - startedAt;
        if (Number.isFinite(current)) elapsed = Math.max(elapsed, Math.min(MAX_DURATION_MS, Math.max(0, Math.floor(current))));
        return elapsed;
    }

    function recordActivity(activity, at) {
        if (!observeActivity || !ACTIVITIES.has(activity)) return;
        state.providerActivity = activity;
        state.providerActivityAtMs = at === undefined ? elapsedMs() : at;
        if (typeof onActivity === 'function') {
            // A telemetry consumer must not change execution/failure behavior.
            // It receives a new allowlisted object, never the mutable state.
            const safe = sanitizeProviderExecutionDiagnostics({ ...state,
                providerActivityAgeMs: Math.max(0, elapsedMs() - state.providerActivityAtMs) });
            try { Promise.resolve(onActivity(safe)).catch(() => {}); } catch (_) {}
        }
    }

    function observeLifecycle(activity) {
        if (LIFECYCLE_ACTIVITIES.has(activity)) recordActivity(activity);
    }

    function observeType(type) {
        errorObservations++;
        // A single response reaching its output cap is not an account/session
        // failure. It must never overwrite a separately observed service stop.
        if (type === 'output-limit') {
            if (!state.providerErrorType) state.providerErrorType = type;
            return;
        }
        // A capacity marker must never make authentication, refusal, quota or
        // connection/deadline failures eligible for capacity recovery. A plain
        // 503 following an explicit capacity error adds its status without
        // erasing the more precise cause.
        if (CAPACITY_BLOCKERS.has(type)) {
            const priority = ['authentication', 'quota', 'refusal', 'timeout', 'network'];
            if (!capacityBlocker || priority.indexOf(type) < priority.indexOf(capacityBlocker)) capacityBlocker = type;
        }
        if (type === 'capacity') capacitySeen = true;
        if (capacitySeen && capacityBlocker) { state.providerErrorType = capacityBlocker; return; }
        if (capacitySeen && type === 'unavailable') return;
        state.providerErrorType = type;
    }

    function observeText(input, activityAt) {
        const errorsBefore = errorObservations;
        // Decode only escapes used in machine error strings. Never JSON.parse
        // arbitrary output or retain the resulting text in a returned object.
        let text = input.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\[rn]/g, ' ').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().replace(/^error:\s*/i, '');
        // JSON output and echoed prompts can contain these same words. Only a
        // recognized CLI transport/error prefix is evidence, including its
        // immediate cause; never search inside an arbitrary trailing payload.
        const reconnect = text.match(/^reconnecting\s*(?:\.{1,3}|…)?\s*(\d{1,4})\s*\/\s*(\d{1,4})\b/i);
        if (reconnect) {
            const attempt = Number(reconnect[1]), limit = Number(reconnect[2]);
            if (attempt > 1000 || limit <= 0 || limit > 1000 || attempt > limit) return;
            state.providerReconnectAttempt = Math.max(state.providerReconnectAttempt || 0, attempt);
            state.providerReconnectLimit = Math.max(state.providerReconnectLimit || 0, limit);
            text = text.slice(reconnect[0].length).trim();
            if (!text.startsWith('(')) { recordActivity('reconnecting', activityAt); return; }
            text = text.slice(1).trim();
        }
        const stream = /^stream\s+disconnected\s+before\s+completion\b/i.test(text);
        if (stream) text = text.replace(/^stream\s+disconnected\s+before\s+completion\s*:\s*/i, '');
        const statusMatch = text.match(/^(?:unexpected\s+status(?:\s+code)?|http(?:\/\d(?:\.\d)?)?(?:\s+status(?:\s+code)?)?)\s*[:=]?\s*([1-5]\d{2})\b/i);
        if (statusMatch) state.providerHttpStatus = Number(statusMatch[1]);
        const system = text.match(/^(EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN)\b/);
        if (system) state.providerSystemCode = system[1];

        // This describes observed technical markers; the caller's existing
        // failure code and refusal/auth/quota stop rules remain authoritative.
        const status = statusMatch ? Number(statusMatch[1]) : undefined;
        if (status === 401 || status === 403 || /^(?:unauthori[sz]ed|authentication\s+(?:failed|required)|not\s+logged\s+in)\b/i.test(text)) observeType('authentication');
        else if (status === 429 || /^(?:quota\s+(?:exceeded|exhausted)|rate[ _-]?limit(?:ed|\s+exceeded)?|usage[ _-]?limit)\b/i.test(text)) observeType('quota');
        else if ([500, 502, 503, 504].includes(status) || /^service\s*unavailable\b/i.test(text)) observeType('unavailable');
        else if (system?.[1] === 'ETIMEDOUT' || /^(?:(?:the\s+)?request\s+(?:has\s+)?timed?\s+out|request\s+timeout|timeout)\b/i.test(text)) observeType('timeout');
        else if (/^selected\s+model\s+is\s+at\s+capacity(?:$|[.!,:;](?:\s|$))/i.test(text)) observeType('capacity');
        else if (system || stream || /^(?:network\s+(?:error|unreachable)|connection\s+(?:failed|reset|refused)|fetch\s+failed|error\s+sending\s+request\s+for\s+url)\b/i.test(text)) observeType('network');
        else if (/^(?:request\s+(?:was\s+)?refused|provider_refusal|policy\s+(?:denied|not\s+allowed))\b/i.test(text)) observeType('refusal');
        else if (/^incomplete response returned, reason: max_output_tokens$/i.test(text)) observeType('output-limit');
        if (reconnect) recordActivity('reconnecting', activityAt);
        else if (errorObservations > errorsBefore) recordActivity('provider-error', activityAt);
    }

    function append(text) {
        // A very long echoed prompt must not acquire a new "line prefix" when
        // its beginning is discarded. Inspect its first bounded prefix once,
        // then skip the rest of that physical line.
        for (let start = 0; start < text.length; start += 1024) {
            pending += text.slice(start, start + 1024);
            let end;
            while ((end = pending.search(/[\r\n]/)) >= 0) {
                if (!discardingLine) observeText(pending.slice(0, end), lastStderrAt);
                pending = pending.slice(end + 1);
                discardingLine = false;
            }
            if (discardingLine) pending = '';
            else if (pending.length > MAX_RECORD_LENGTH) { observeText(pending.slice(0, MAX_RECORD_LENGTH), lastStderrAt); pending = ''; discardingLine = true; }
        }
    }

    function observeStderr(chunk) {
        if ((typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) && chunk.length) {
            stderrRevision++;
            if (observeActivity) lastStderrAt = elapsedMs();
        }
        if (typeof chunk === 'string') append(chunk);
        else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            for (let start = 0; start < chunk.length; start += 1024) append(decoder.write(Buffer.from(chunk.subarray(start, start + 1024))));
        }
    }

    function observeEvent(event) {
        // CLI lifecycle events indicate only observed protocol activity. A
        // thread/turn start is not evidence that text is being generated.
        if (event && typeof event === 'object' && !Array.isArray(event)) {
            if (event.type === 'thread.started') recordActivity('thread-started');
            else if (event.type === 'turn.started') recordActivity('turn-started');
            else if (event.type === 'turn.completed') recordActivity('turn-completed');
            else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)
                && event.item && typeof event.item === 'object' && !Array.isArray(event.item)
                && ['agent_message', 'assistant_message'].includes(event.item.type)) recordActivity('message-observed');
        }
        if (!event || !['turn.failed', 'error'].includes(event.type)) return;
        const error = event.error && typeof event.error === 'object' && !Array.isArray(event.error) ? event.error : {};
        const message = typeof error.message === 'string' ? error.message : typeof event.message === 'string' ? event.message : '';
        // A typed error event is separate from an unterminated stderr line.
        // Inspect only its first bounded line, never arbitrary event payloads.
        observeText(message.slice(0, MAX_RECORD_LENGTH).split(/[\r\n]/, 1)[0]);
        const status = Number.isSafeInteger(error.status) ? error.status : Number.isSafeInteger(error.status_code) ? error.status_code : undefined;
        if (status >= 100 && status <= 599) observeText('HTTP status ' + status);
        if (NETWORK_CODES.has(error.code)) observeText(error.code);
        // This is a documented machine error code. Do not search for it in
        // free-form messages, prompts, JSON output or nested request objects.
        if (error.code === 'server_is_overloaded') observeType('capacity');
        const retryAfter = error.headers?.['retry-after'] ?? error.headers?.['Retry-After'];
        if (retryAfter !== undefined) {
            const milliseconds = typeof retryAfter === 'string' && /^\d{1,8}$/.test(retryAfter) ? Number(retryAfter) * 1000
                : typeof retryAfter === 'string' && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)
                    ? Math.max(0, Date.parse(retryAfter) - now()) : NaN;
            if (Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_DURATION_MS) state.providerRetryAfterMs = Math.max(state.providerRetryAfterMs || 0, milliseconds);
            else state.providerRetryAfterInvalid = true;
        }
        recordActivity('provider-error');
    }

    function snapshot(meta = {}) {
        // Polling an unterminated stderr line is not new activity. Use its last
        // observed byte time once; repeated snapshots cannot keep it fresh.
        if (!discardingLine && inspectedPendingRevision !== stderrRevision) {
            inspectedPendingRevision = stderrRevision;
            observeText(pending, lastStderrAt);
        }
        const activity = observeActivity && state.providerActivity ? { providerActivityAgeMs: Math.max(0, elapsedMs() - state.providerActivityAtMs) } : {};
        return sanitizeProviderExecutionDiagnostics({ ...state, ...activity, ...sanitizeProviderExecutionDiagnostics(meta) });
    }

    return { observeStderr, observeEvent, observeLifecycle, snapshot };
}

module.exports = { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics };
