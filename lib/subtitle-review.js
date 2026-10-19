const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalidReview() {
    return Object.assign(new Error('한국어 자막 검수의 승인·수정 번호나 대사 형식이 올바르지 않습니다.'), {
        code: 'SUBTITLE_BATCH_INVALID'
    });
}

function requestedIndexes(entries) {
    if (!Array.isArray(entries) || !entries.length) throw invalidReview();
    const indexes = entries.map(entry => entry?.index);
    if (indexes.some(index => !Number.isSafeInteger(index) || index < 0)
        || new Set(indexes).size !== indexes.length) throw invalidReview();
    return indexes;
}

function buildSubtitleReviewSchema(entries) {
    const indexes = requestedIndexes(entries);
    const index = { type: 'integer', enum: indexes };
    return {
        type: 'object', additionalProperties: false,
        properties: {
            approvedIndexes: { type: 'array', minItems: 0, maxItems: indexes.length, items: index },
            corrections: { type: 'array', minItems: 0, maxItems: indexes.length,
                items: { type: 'object', additionalProperties: false,
                    properties: { index, text: { type: 'string' } }, required: ['index', 'text'] } },
            terms: { type: 'array', maxItems: 100,
                items: { type: 'object', additionalProperties: false,
                    properties: { source: { type: 'string' }, translation: { type: 'string' } },
                    required: ['source', 'translation'] } }
        },
        required: ['approvedIndexes', 'corrections', 'terms']
    };
}

function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => hasOwn(value, key));
}

function draftLookup(drafts) {
    if (drafts instanceof Map) return index => drafts.get(index);
    if (!Array.isArray(drafts)) throw invalidReview();
    const byIndex = new Map();
    for (const cue of drafts) {
        if (!cue || !Number.isSafeInteger(cue.index) || byIndex.has(cue.index)) throw invalidReview();
        byIndex.set(cue.index, cue.text);
    }
    return index => byIndex.get(index);
}

// An approval is an explicit review result, never a default for omitted cues.
// Missing indexes stay missing so the caller's existing bounded recovery and
// contiguous-prefix rules remain authoritative. Korean, omission and term
// consistency checks still run on the expanded cues in the caller.
function expandSubtitleReview(result, requested, drafts) {
    // Preserve provider refusal evidence before any shape check. Legacy full
    // responses also retain their original object for the caller's validator.
    if (result?.refusal || !result || typeof result !== 'object'
        || !hasOwn(result, 'approvedIndexes') && !hasOwn(result, 'corrections')) return result;
    const indexes = requestedIndexes(requested), expected = new Set(indexes);
    if (!exactKeys(result, ['approvedIndexes', 'corrections', 'terms'])
        || !Array.isArray(result.approvedIndexes) || !Array.isArray(result.corrections)
        || !Array.isArray(result.terms) || result.approvedIndexes.length > indexes.length
        || result.corrections.length > indexes.length || result.terms.length > 100) throw invalidReview();
    const returned = new Map();
    const acceptIndex = index => {
        if (!Number.isSafeInteger(index) || !expected.has(index) || returned.has(index)) throw invalidReview();
    };
    const getDraft = result.approvedIndexes.length ? draftLookup(drafts) : null;
    for (const index of result.approvedIndexes) {
        acceptIndex(index);
        const text = getDraft(index);
        if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw invalidReview();
        returned.set(index, { index, text });
    }
    for (const cue of result.corrections) {
        if (!exactKeys(cue, ['index', 'text'])) throw invalidReview();
        acceptIndex(cue.index);
        if (typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 10000) throw invalidReview();
        returned.set(cue.index, { index: cue.index, text: cue.text });
    }
    for (const term of result.terms) {
        if (!exactKeys(term, ['source', 'translation'])
            || typeof term.source !== 'string' || typeof term.translation !== 'string') throw invalidReview();
    }
    return { subtitles: indexes.filter(index => returned.has(index)).map(index => returned.get(index)), terms: result.terms };
}

module.exports = { buildSubtitleReviewSchema, expandSubtitleReview };
