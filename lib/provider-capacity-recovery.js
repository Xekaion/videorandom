'use strict';

const LIMITS = Object.freeze({ retriesPerRequest: 2, retriesPerJob: 4, windowMs: 10 * 60 * 1000,
    baseDelayMs: 30000, maxDelayMs: 5 * 60 * 1000, jitterMs: 5000 });
const NON_CAPACITY_STATUS = new Set([401, 403, 429]);
const NETWORK_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

function abortError(signal) {
    if (signal?.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
    return Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
}

function checkAbort(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function waitForRetry(milliseconds, { signal } = {}) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const finish = error => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve();
        };
        const onAbort = () => finish(abortError(signal));
        const timer = setTimeout(() => finish(), milliseconds);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

// This gate accepts trusted technical evidence from the execution observer,
// never a substring from a prompt, subtitle, arbitrary response or error text.
function isProviderCapacityError(error) {
    return error?.code === 'PROVIDER_CAPACITY' && error.name !== 'AbortError'
        && ['provider-error', 'process-exit'].includes(error.executionSource) && error.providerErrorType === 'capacity'
        && !error.refusalSource && !NON_CAPACITY_STATUS.has(error.httpStatus)
        && !NON_CAPACITY_STATUS.has(error.providerHttpStatus)
        && !NETWORK_CODES.has(error.systemCode) && !NETWORK_CODES.has(error.providerSystemCode)
        && !error.causeCode && !error.cause;
}

function boundedInteger(value, maximum, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`Invalid ${label}`);
    return value;
}

function createProviderCapacityRecovery({ now = Date.now, random = Math.random, wait = waitForRetry,
    maxRetriesPerRequest = LIMITS.retriesPerRequest, maxRetriesPerJob = LIMITS.retriesPerJob,
    maxElapsedMs = LIMITS.windowMs } = {}) {
    if (typeof now !== 'function' || typeof random !== 'function' || typeof wait !== 'function') throw new TypeError('Invalid capacity recovery dependencies');
    boundedInteger(maxRetriesPerRequest, LIMITS.retriesPerRequest, 'request retry limit');
    boundedInteger(maxRetriesPerJob, LIMITS.retriesPerJob, 'job retry limit');
    if (boundedInteger(maxElapsedMs, LIMITS.windowMs, 'recovery deadline') === 0) throw new TypeError('Invalid recovery deadline');
    let retriesUsed = 0, startedAt, lastNow = 0;

    function clock() {
        const value = now();
        if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid recovery clock');
        lastNow = Math.max(lastNow, value);
        return lastNow;
    }

    function exhausted(error, retries, reason) {
        Object.assign(error, { providerCapacityExhausted: true, providerCapacityStopReason: reason,
            providerCapacityRetryCount: retries, providerCapacityJobRetries: retriesUsed });
        return error;
    }

    async function run(operation, { signal, onRetry, maxRequestElapsedMs } = {}) {
        if (typeof operation !== 'function') throw new TypeError('Invalid capacity recovery operation');
        if (maxRequestElapsedMs !== undefined && (!Number.isSafeInteger(maxRequestElapsedMs)
            || maxRequestElapsedMs < 1 || maxRequestElapsedMs > 180000)) throw new TypeError('Invalid request budget');
        const requestStarted = maxRequestElapsedMs === undefined ? undefined : clock();
        const remaining = () => requestStarted === undefined ? undefined : Math.max(0, requestStarted + maxRequestElapsedMs - clock());
        let retries = 0;
        for (;;) {
            checkAbort(signal);
            try { return await operation({ remainingMs: remaining() }); }
            catch (error) {
                if (!isProviderCapacityError(error)) throw error;
                checkAbort(signal);
                const current = clock();
                if (startedAt === undefined) startedAt = current;
                if (retries >= maxRetriesPerRequest) throw exhausted(error, retries, 'request-limit');
                if (retriesUsed >= maxRetriesPerJob) throw exhausted(error, retries, 'job-limit');
                if (error.providerRetryAfterInvalid) throw exhausted(error, retries, 'retry-after-invalid');
                const retryAfter = error.providerRetryAfterMs;
                if (retryAfter !== undefined && (!Number.isSafeInteger(retryAfter) || retryAfter < 0)) {
                    throw exhausted(error, retries, 'retry-after-invalid');
                }
                // A long server delay is never truncated to send a request sooner.
                if (retryAfter > LIMITS.maxDelayMs) throw exhausted(error, retries, 'retry-after-limit');
                const randomValue = random();
                const unit = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
                const jitter = Math.min(LIMITS.jitterMs, Math.floor(unit * (LIMITS.jitterMs + 1)));
                const waitMs = Math.max(LIMITS.baseDelayMs * (2 ** retries) + jitter, retryAfter || 0);
                if (current + waitMs >= startedAt + maxElapsedMs) throw exhausted(error, retries, 'deadline');
                // A logical translation request includes capacity backoff and
                // every child attempt. Never truncate Retry-After to fit it.
                if (requestStarted !== undefined && waitMs >= remaining()) throw exhausted(error, retries, 'deadline');
                // Reserve synchronously before waiting, including parallel draft
                // requests, so one job can never spend more than its shared limit.
                retries++;
                retriesUsed++;
                if (typeof onRetry === 'function') {
                    try { Promise.resolve(onRetry({ waitMs, retry: retries, maxRetries: maxRetriesPerRequest,
                        jobRetries: retriesUsed, maxJobRetries: maxRetriesPerJob })).catch(() => {}); } catch (_) {}
                }
                checkAbort(signal);
                await wait(waitMs, { signal });
                checkAbort(signal);
                if (requestStarted !== undefined && remaining() === 0) throw exhausted(error, retries, 'deadline');
                if (clock() >= startedAt + maxElapsedMs) throw exhausted(error, retries, 'deadline');
            }
        }
    }

    return { run, snapshot: () => ({ retriesUsed, maxRetries: maxRetriesPerJob,
        remainingRetries: Math.max(0, maxRetriesPerJob - retriesUsed) }) };
}

module.exports = { createProviderCapacityRecovery, isProviderCapacityError, PROVIDER_CAPACITY_LIMITS: LIMITS };
