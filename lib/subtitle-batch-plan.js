const LONG_TRANSCRIPT_CUES = 960;
const LONG_VIDEO_SECONDS = 60 * 60;
const STANDARD_BATCH = { maxCues: 80, maxTextUnits: 12000 };
const LONG_BATCH = { maxCues: 32, maxTextUnits: 4800 };

// Use the original duration/count, not how many translations remain. A long
// video can have a sparse transcript and still need smaller requests.
function subtitleBatchAt(transcript, pendingIndexes, offset, durationSeconds) {
    const long = transcript.length >= LONG_TRANSCRIPT_CUES || Number.isFinite(durationSeconds) && durationSeconds >= LONG_VIDEO_SECONDS;
    const { maxCues, maxTextUnits } = long ? LONG_BATCH : STANDARD_BATCH;
    const entries = [];
    let textUnits = 0;
    while (offset + entries.length < pendingIndexes.length && entries.length < maxCues) {
        const index = pendingIndexes[offset + entries.length];
        const { text, id } = transcript[index];
        // An individual long cue still gets one request; skipping it or
        // returning an empty batch would either lose content or stall traversal.
        if (entries.length && textUnits + text.length > maxTextUnits) break;
        entries.push({ index, text, ...(id !== undefined ? { id } : {}) });
        textUnits += text.length;
    }
    return entries;
}

module.exports = { subtitleBatchAt };
