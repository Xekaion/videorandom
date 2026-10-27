const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('accurate recovery merge keeps source-order and exact decisions using neutral metadata', t => {
  const binary = process.env.VIDEORANDOM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(binary, ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_asr_merge_v1933.py', '-v'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  });
  if (result.error?.code === 'ENOENT') { t.skip('Python is unavailable.'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 12 tests/);
});
