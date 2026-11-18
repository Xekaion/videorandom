const BASE_WIDTH = 32;
const MAX_WIDTH = 64;
const WIDTH_STEP = 16;
const CLEAN_GROUPS_TO_GROW = 4;
const MIN_STEADY_REQUEST_MS = 1200;
const MAX_STEADY_REQUEST_MS = 12000;

function isSteadyRequest(request) {
  return request?.turnStarted === true && request.interrupted === false
    && Number.isFinite(request.elapsedMs)
    && request.elapsedMs >= MIN_STEADY_REQUEST_MS && request.elapsedMs <= MAX_STEADY_REQUEST_MS;
}

function createSubtitleBatchPace({ enabled = false } = {}) {
  let width = BASE_WIDTH;
  let consecutiveCleanGroups = 0;
  return {
    get width() { return width; },
    observe({ clean, requests } = {}) {
      if (!enabled) return;
      // Each group needs both the draft and independent review. Missing
      // observations or additional requests cannot certify a healthy group.
      if (clean !== true || !Array.isArray(requests) || requests.length !== 2
          || !isSteadyRequest(requests[0]) || !isSteadyRequest(requests[1])) {
        width = BASE_WIDTH;
        consecutiveCleanGroups = 0;
        return;
      }
      if (width === MAX_WIDTH) return;
      consecutiveCleanGroups++;
      if (consecutiveCleanGroups === CLEAN_GROUPS_TO_GROW) {
        width += WIDTH_STEP;
        consecutiveCleanGroups = 0;
      }
    }
  };
}

module.exports = { createSubtitleBatchPace };
