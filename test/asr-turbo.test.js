const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('turbo ASR bounds batches, covers all source samples and preserves real cue times with owned fakes', t => {
  const binary = process.env.VIDEORANDOM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(binary, ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_asr_turbo.py', '-v'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  });
  if (result.error?.code === 'ENOENT') { t.skip('Python is unavailable.'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 17 tests/);
});
