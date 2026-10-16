const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { makeManifest } = require('../scripts/write_update_manifest');
const { validateManifest } = require('../lib/app-update');

test('a built release manifest is accepted by the downloader and describes the exact executable bytes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-release-manifest-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('videorandom-release-manifest-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const filename = path.join(root, 'owned.exe'), bytes = Buffer.from('MZ owned synthetic updater test; never executed');
  await fs.writeFile(filename, bytes);
  const manifest = await makeManifest(filename, '1.9.0');
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.equal(manifest.asset.sizeBytes, bytes.length);
  assert.equal(manifest.asset.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  await fs.writeFile(filename, 'This is not an executable.');
  await assert.rejects(makeManifest(filename, '1.9.0'), /Windows executable/);
  await assert.rejects(makeManifest(filename, '../unsafe'), /version/);
});
