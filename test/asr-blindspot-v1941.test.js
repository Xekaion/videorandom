const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeTranscriptionQuality } = require('../lib/subtitle-quality');

test('independent acoustic review recovers VAD blind spots without fabricated cues and bounds encoder inputs', t => {
  const binary = process.env.VIDEORANDOM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(binary, ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_asr_blindspot_v1941.py', '-v'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  });
  if (result.error?.code === 'ENOENT') { t.skip('Python is unavailable.'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 17 tests/);
});

test('acoustic audit metadata survives normalization without certifying unresolved sound', () => {
  const quality = { version: 1, source: 'audio', recognitionRevision: 4, profile: 'accurate', model: 'large-v3',
    duration: 90, processedUntil: 90, complete: true,
    audit: { complete: true, unresolved: [], acousticCandidateSeconds: 2, unresolvedAcousticSeconds: 0, openingRecheckedSeconds: 40.6 } };
  const normal = normalizeTranscriptionQuality(quality);
  assert.equal(normal.audit.acousticCandidateSeconds, 2);
  assert.equal(normal.audit.openingRecheckedSeconds, 40.6);
  assert.equal(normal.audit.complete, true);
  for (const changed of [{ unresolvedAcousticSeconds: 0.5 }, { acousticCandidateSeconds: 91 },
    { unresolvedAcousticSeconds: -1 }, { openingRecheckedSeconds: 91 }]) {
    assert.equal(normalizeTranscriptionQuality({ ...quality, audit: { ...quality.audit, ...changed } }).audit.complete, false);
  }
});
