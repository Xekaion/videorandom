const { StringDecoder } = require('node:string_decoder');

// Provider output may contain a prompt, subtitle text, paths or credentials.
// Keep only these technical enums and bounded numbers, never an output excerpt.
const EXECUTION_SOURCES = new Set(['local-deadline', 'provider-error', 'process-exit', 'process-error', 'cancelled']);
const ERROR_TYPES = new Set(['timeout', 'authentication', 'quota', 'unavailable', 'network', 'refusal']);
const NETWORK_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
const MAX_RECORD_LENGTH = 4096;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeProviderExecutionDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result = {};
    if (EXECUTION_SOURCES.has(value.executionSource)) result.executionSource = value.executionSource;
    if (ERROR_TYPES.has(value.providerErrorType)) result.providerErrorType = value.providerErrorType;
    if (NETWORK_CODES.has(value.providerSystemCode)) result.providerSystemCode = value.providerSystemCode;
    for (const key of ['executionElapsedMs', 'executionDeadlineMs']) {
        if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_DURATION_MS) result[key] = value[key];
    }
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

function createProviderExecutionDiagnostics() {
    const state = {};
    const decoder = new StringDecoder('utf8');
    let pending = '', discardingLine = false;

    function observeText(input) {
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
            if (!text.startsWith('(')) return;
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
        if (status === 401 || status === 403 || /^(?:unauthori[sz]ed|authentication\s+(?:failed|required)|not\s+logged\s+in)\b/i.test(text)) state.providerErrorType = 'authentication';
        else if (status === 429 || /^(?:quota\s+(?:exceeded|exhausted)|rate[ _-]?limit(?:ed|\s+exceeded)?|usage[ _-]?limit)\b/i.test(text)) state.providerErrorType = 'quota';
        else if ([500, 502, 503, 504].includes(status) || /^service\s*unavailable\b/i.test(text)) state.providerErrorType = 'unavailable';
        else if (system?.[1] === 'ETIMEDOUT' || /^(?:(?:the\s+)?request\s+(?:has\s+)?timed?\s+out|request\s+timeout|timeout)\b/i.test(text)) state.providerErrorType = 'timeout';
        else if (system || stream || /^(?:network\s+(?:error|unreachable)|connection\s+(?:failed|reset|refused)|fetch\s+failed|error\s+sending\s+request\s+for\s+url)\b/i.test(text)) state.providerErrorType = 'network';
        else if (/^(?:request\s+(?:was\s+)?refused|provider_refusal|policy\s+(?:denied|not\s+allowed))\b/i.test(text)) state.providerErrorType = 'refusal';
    }

    function append(text) {
        // A very long echoed prompt must not acquire a new "line prefix" when
        // its beginning is discarded. Inspect its first bounded prefix once,
        // then skip the rest of that physical line.
        for (let start = 0; start < text.length; start += 1024) {
            pending += text.slice(start, start + 1024);
            let end;
            while ((end = pending.search(/[\r\n]/)) >= 0) {
                if (!discardingLine) observeText(pending.slice(0, end));
                pending = pending.slice(end + 1);
                discardingLine = false;
            }
            if (discardingLine) pending = '';
            else if (pending.length > MAX_RECORD_LENGTH) { observeText(pending.slice(0, MAX_RECORD_LENGTH)); pending = ''; discardingLine = true; }
        }
    }

    function observeStderr(chunk) {
        if (typeof chunk === 'string') append(chunk);
        else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            for (let start = 0; start < chunk.length; start += 1024) append(decoder.write(Buffer.from(chunk.subarray(start, start + 1024))));
        }
    }

    function observeEvent(event) {
        if (!event || !['turn.failed', 'error'].includes(event.type)) return;
        const error = event.error && typeof event.error === 'object' && !Array.isArray(event.error) ? event.error : {};
        const message = typeof error.message === 'string' ? error.message : typeof event.message === 'string' ? event.message : '';
        // A typed error event is separate from an unterminated stderr line.
        // Inspect only its first bounded line, never arbitrary event payloads.
        observeText(message.slice(0, MAX_RECORD_LENGTH).split(/[\r\n]/, 1)[0]);
        const status = Number.isSafeInteger(error.status) ? error.status : Number.isSafeInteger(error.status_code) ? error.status_code : undefined;
        if (status >= 100 && status <= 599) observeText('HTTP status ' + status);
        if (NETWORK_CODES.has(error.code)) observeText(error.code);
    }

    function snapshot(meta = {}) {
        if (!discardingLine) observeText(pending);
        return sanitizeProviderExecutionDiagnostics({ ...state, ...sanitizeProviderExecutionDiagnostics(meta) });
    }

    return { observeStderr, observeEvent, snapshot };
}

module.exports = { createProviderExecutionDiagnostics, sanitizeProviderExecutionDiagnostics };
