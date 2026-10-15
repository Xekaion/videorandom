const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetrics, stageIdentity } = require('../lib/job-metrics');

test('stage timings reflect measured intervals and freeze after completion without an invented ETA', () => {
  let now = 1000;
  const metrics = createMetrics(() => now);
  now = 1025; metrics.stage('transcription');
  now = 1125; metrics.stage('transcription');
  now = 1325; metrics.stage('한국어 자막 번역 1/2구간');
  now = 1350;
  const result = metrics.finish();
  assert.equal(result.totalMs, 350);
  assert.deepEqual(result.stages.map(stage => [stage.stageKey, stage.durationMs]), [['prepare', 25], ['transcription', 300], ['translation', 25]]);
  now = 9999; metrics.stage('summary');
  assert.deepEqual(metrics.finish(), result);
  assert.equal('eta' in result, false);
});

test('unknown diagnostic stage input never stores raw paths, credentials or source speech in metrics', () => {
  const raw = 'C:\\private\\folder\\secret-video.mp4 connectionCode=owned-secret';
  assert.deepEqual(stageIdentity(raw), { stageKey: 'processing', label: '영상 분석' });
  let now = 0; const metrics = createMetrics(() => now);
  now = 10; metrics.stage(raw); now = 20;
  const serialized = JSON.stringify(metrics.finish());
  assert.equal(serialized.includes('private'), false); assert.equal(serialized.includes('owned-secret'), false);
});
