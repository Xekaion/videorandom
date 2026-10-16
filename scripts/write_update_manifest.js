const fs = require('node:fs/promises');
const path = require('node:path');
const { fileHash } = require('../lib/app-update-restart');

async function makeManifest(filename, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Invalid release version.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 180 * 1024 * 1024) throw new Error('Invalid release executable.');
  const handle = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    if (header.toString('ascii') !== 'MZ') throw new Error('The release must be a Windows executable.');
  } finally { await handle.close(); }
  return { schemaVersion: 1, updateProtocol: 1, version, asset: {
    url: `https://raw.githubusercontent.com/Xekaion/videorandom/v${version}/videorandom.exe`,
    sha256: await fileHash(filename), sizeBytes: stat.size } };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = await makeManifest(path.join(root, 'videorandom.exe'), require('../package.json').version);
  const temporary = path.join(root, '.update-manifest.tmp');
  await fs.writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'w' });
  await fs.rename(temporary, path.join(root, 'update.json'));
  console.log(`Verified update manifest: v${manifest.version}, ${manifest.asset.sizeBytes} bytes, SHA256 ${manifest.asset.sha256}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { makeManifest };
