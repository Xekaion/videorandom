const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubtitleBatchPace } = require('../lib/subtitle-batch-pace');

const signal = (elapsedMs, extra = {}) => ({ turnStarted: true, interrupted: false, elapsedMs, ...extra });
const healthy = { clean: true, requests: [signal(1200), signal(12000)] };
function observe(pace, count, group = healthy) {
  for (let index = 0; index < count; index++) pace.observe(group);
}

test('four consecutive verified groups raise the long-request width by one step, capped at 64', () => {
  const pace = createSubtitleBatchPace({ enabled: true });
  assert.equal(pace.width, 32);
  observe(pace, 3);
  assert.equal(pace.width, 32);
  observe(pace, 1);
  assert.equal(pace.width, 48);
  observe(pace, 3);
  assert.equal(pace.width, 48);
  observe(pace, 100);
  assert.equal(pace.width, 64);
});

test('unverified, incomplete, stalled or interrupted responses immediately reset the width and streak', () => {
  const setbacks = [undefined, { ...healthy, clean: false }, { clean: true },
    { clean: true, requests: [] }, { clean: true, requests: [signal(4000)] },
    { clean: true, requests: [signal(4000), signal(4000), signal(4000)] }];
  for (const request of [undefined, signal(1199), signal(12001), signal(Infinity), signal('4000'),
    signal(4000, { turnStarted: false }), signal(4000, { interrupted: true }),
    signal(4000, { interrupted: undefined })]) {
    setbacks.push({ clean: true, requests: [signal(4000), request] });
  }
  for (const setback of setbacks) {
    const pace = createSubtitleBatchPace({ enabled: true });
    observe(pace, 8);
    assert.equal(pace.width, 64);
    pace.observe(setback);
    assert.equal(pace.width, 32);
    observe(pace, 3);
    assert.equal(pace.width, 32);
    pace.observe(setback);
    observe(pace, 3);
    assert.equal(pace.width, 32);
    observe(pace, 1);
    assert.equal(pace.width, 48);
  }
});

test('the disabled policy remains at the default batch width', () => {
  const pace = createSubtitleBatchPace();
  observe(pace, 32);
  assert.equal(pace.width, 32);
});
