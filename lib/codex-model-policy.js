'use strict';

const MODEL_ID = /^gpt-[a-z0-9][a-z0-9.-]{0,79}$/;
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

function sanitizeCodexModelPolicy(value) {
    if (!value || typeof value.requestedModel !== 'string' || !MODEL_ID.test(value.requestedModel) || !EFFORTS.has(value.reasoningEffort)
        || value.serviceTier !== 'standard') return undefined;
    return { requestedModel: value.requestedModel, reasoningEffort: value.reasoningEffort, serviceTier: 'standard' };
}

function codexModelPolicy(environment = {}) {
    const policy = sanitizeCodexModelPolicy({ requestedModel: environment.VIDEORANDOM_CODEX_MODEL || 'gpt-6-luna',
        reasoningEffort: environment.VIDEORANDOM_CODEX_REASONING_EFFORT || 'low', serviceTier: 'standard' });
    if (!policy) throw new TypeError('분석 모델 또는 추론 설정이 올바르지 않습니다.');
    return Object.freeze(policy);
}

function codexModelArguments(policy) {
    const clean = sanitizeCodexModelPolicy(policy);
    if (!clean) throw new TypeError('분석 모델 설정이 올바르지 않습니다.');
    return ['--model', clean.requestedModel, '-c', `model_reasoning_effort="${clean.reasoningEffort}"`,
        '-c', 'service_tier="default"', '--disable', 'fast_mode'];
}

function modelDiagnosticPolicy(policy) {
    const clean = sanitizeCodexModelPolicy(policy);
    return clean ? { providerRequestedModel: clean.requestedModel, providerReasoningEffort: clean.reasoningEffort,
        providerServiceTier: clean.serviceTier } : {};
}

function sanitizeCodexModels(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = {};
    for (const operation of ['summary', 'translation']) {
        const policy = sanitizeCodexModelPolicy(value[operation]);
        if (policy) result[operation] = policy;
    }
    return Object.keys(result).length ? result : undefined;
}

module.exports = { codexModelPolicy, codexModelArguments, sanitizeCodexModelPolicy, modelDiagnosticPolicy, sanitizeCodexModels };
