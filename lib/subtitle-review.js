const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const shapeIssues = new WeakMap();

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

function reviewShapeIssues(result) {
    const issues = result && typeof result === 'object' ? shapeIssues.get(result) : undefined;
    return issues && { invalidIndexes: [...issues.invalidIndexes], unassignedRows: issues.unassignedRows };
}

function expandValidReviewRows(result, indexes, expected, getDraft) {
    const returned = new Map(), seen = new Set(), invalidIndexes = new Set();
    let unassignedRows = 0;
    const accept = (index, valid, text) => {
        if (!Number.isSafeInteger(index) || !expected.has(index)) {
            unassignedRows++;
            return;
        }
        // Every duplicate is ambiguous, including identical corrections and an
        // approval that overlaps a correction. Keep no candidate for that cue.
        if (seen.has(index)) {
            invalidIndexes.add(index);
            returned.delete(index);
            return;
        }
        seen.add(index);
        if (!valid) invalidIndexes.add(index);
        else returned.set(index, { index, text });
    };
    for (const index of result.approvedIndexes) {
        if (!Number.isSafeInteger(index) || !expected.has(index)) {
            accept(index, false);
            continue;
        }
        const text = getDraft(index);
        // The drafts are trusted caller input. An invalid draft is an internal
        // integrity error, not a malformed provider row that may be discarded.
        if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw invalidReview();
        accept(index, true, text);
    }
    for (const cue of result.corrections) {
        const valid = exactKeys(cue, ['index', 'text']) && typeof cue.text === 'string'
            && !!cue.text.trim() && cue.text.length <= 10000;
        accept(cue?.index, valid, valid ? cue.text : undefined);
    }
    const expanded = {
        subtitles: indexes.filter(index => returned.has(index)).map(index => returned.get(index)),
        terms: result.terms
    };
    shapeIssues.set(expanded, {
        invalidIndexes: indexes.filter(index => invalidIndexes.has(index)), unassignedRows
    });
    return expanded;
}

// An approval is an explicit review result, never a default for omitted cues.
// Missing indexes stay missing so the caller's existing bounded recovery and
// contiguous-prefix rules remain authoritative. Korean, omission and term
// consistency checks still run on the expanded cues in the caller.
function expandSubtitleReview(result, requested, drafts, options) {
    // Preserve provider refusal evidence before any shape check. Legacy full
    // responses also retain their original object for the caller's validator.
    if (result?.refusal || !result || typeof result !== 'object'
        || !hasOwn(result, 'approvedIndexes') && !hasOwn(result, 'corrections')) return result;
    const indexes = requestedIndexes(requested), expected = new Set(indexes);
    const allowInvalidRows = options?.allowInvalidRows === true;
    if (!exactKeys(result, ['approvedIndexes', 'corrections', 'terms'])
        || !Array.isArray(result.approvedIndexes) || !Array.isArray(result.corrections)
        || !Array.isArray(result.terms) || !allowInvalidRows && (result.approvedIndexes.length > indexes.length
            || result.corrections.length > indexes.length)
        || allowInvalidRows && result.approvedIndexes.length + result.corrections.length > 50000
        || result.terms.length > 100) throw invalidReview();
    for (const term of result.terms) {
        if (!exactKeys(term, ['source', 'translation'])
            || typeof term.source !== 'string' || typeof term.translation !== 'string') throw invalidReview();
    }
    const getDraft = result.approvedIndexes.length ? draftLookup(drafts) : null;
    if (allowInvalidRows) return expandValidReviewRows(result, indexes, expected, getDraft);
    const returned = new Map();
    const acceptIndex = index => {
        if (!Number.isSafeInteger(index) || !expected.has(index) || returned.has(index)) throw invalidReview();
    };
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
    return { subtitles: indexes.filter(index => returned.has(index)).map(index => returned.get(index)), terms: result.terms };
}

module.exports = { buildSubtitleReviewSchema, expandSubtitleReview, reviewShapeIssues };
