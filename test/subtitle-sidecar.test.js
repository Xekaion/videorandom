const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { COPYFILE_EXCL } = require('node:fs').constants;
const { subtitleText } = require('../lib/subtitle-utils');
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');

const id = '0123456789abcdef0123456789abcdef';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-'));
  // Canonicalize the fixture root for systems whose temporary directory is an alias.
  const root = await fs.realpath(directory);
  const videoPath = path.join(root, '언어 연습.mp4');
  await fs.writeFile(videoPath, 'owned neutral media fixture');
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('videorandom-sidecar-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const record = {
    id, path: videoPath, name: '../../untrusted-name.mp4', status: 'completed', subtitleLanguage: 'ko',
    transcript: [{ start: 0.125, end: 2.375, text: 'こんにちは。' }, { start: 3.75, end: 6.025, text: '今天天气很好。' }],
    subtitleTranslation: [{ start: 0.125, end: 2.375, text: '안녕하세요.' }, { start: 3.75, end: 6.025, text: '오늘은 날씨가 좋습니다.' }]
  };
  return { root, videoPath, record, normal: path.join(root, '언어 연습.ko.srt'),
    alternate: path.join(root, '언어 연습.videorandom-0123456789ab.ko.srt'),
    bytes: Buffer.from(subtitleText(record, { format: 'srt', language: 'ko' }), 'utf8') };
}

async function noTemporaryFiles(root) {
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
}

function revisedRecord(record) {
  return { ...record, id: 'fedcba9876543210fedcba9876543210', subtitleTranslation: record.subtitleTranslation.map((cue, index) =>
    ({ ...cue, text: index ? '오늘은 날씨가 아주 좋습니다.' : '다시 안녕하세요.' })) };
}

async function ownedPrevious(f) {
  const previous = await saveKoreanSubtitle(f.record);
  assert.equal(previous.path, f.normal);
  return [{ path: previous.path, sha256: previous.sha256 }];
}

test('trusted generated Korean subtitles update the canonical player filename and preserve the exact former bytes in a unique backup', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  const revision = revisedRecord(f.record);
  const result = await saveKoreanSubtitle(revision, { generatedSubtitleFiles });
  assert.equal(result.status, 'saved');
  assert.equal(result.path, f.normal);
  assert.equal(result.updated, true);
  assert.match(result.backupPath, /\.ko\.srt\.videorandom-[a-f0-9]{32}\.bak$/);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  assert.equal((await fs.readFile(result.path, 'utf8')), subtitleText(revision, { language: 'ko' }));
  assert.equal(result.sha256, crypto.createHash('sha256').update(await fs.readFile(result.path)).digest('hex'));
  await noTemporaryFiles(f.root);
});

test('missing, mismatched, relative or edited provenance never authorizes replacing an existing subtitle', async t => {
  for (const mode of ['missing', 'mismatched', 'relative', 'edited', 'record-only']) {
    const f = await fixture(t);
    let generatedSubtitleFiles = await ownedPrevious(f);
    if (mode === 'missing' || mode === 'record-only') generatedSubtitleFiles = [];
    if (mode === 'mismatched') generatedSubtitleFiles = [{ path: f.normal, sha256: '0'.repeat(64) }];
    if (mode === 'relative') generatedSubtitleFiles = [{ path: path.basename(f.normal), sha256: generatedSubtitleFiles[0].sha256 }];
    if (mode === 'edited') await fs.writeFile(f.normal, 'manual edited subtitles');
    const before = await fs.readFile(f.normal);
    const result = await saveKoreanSubtitle({ ...revisedRecord(f.record), generatedSubtitleFiles: [{ path: f.normal, sha256: crypto.createHash('sha256').update(before).digest('hex') }] }, { generatedSubtitleFiles });
    assert.equal(result.status, 'saved', mode);
    assert.notEqual(result.path, f.normal, mode);
    assert.equal(result.updated, undefined);
    assert.deepEqual(await fs.readFile(f.normal), before);
    assert.equal((await fs.readdir(f.root)).some(name => name.endsWith('.bak')), false);
    await noTemporaryFiles(f.root);
  }
});

test('a backup-name collision is preserved and a fresh random backup name is used', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  let collision;
  const io = { ...fs, lstat: async filename => {
    if (!collision && filename.endsWith('.bak')) { collision = filename; await fs.writeFile(filename, 'user backup'); }
    return fs.lstat(filename);
  } };
  const result = await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, io });
  assert.equal(result.updated, true);
  assert.notEqual(result.backupPath, collision);
  assert.equal(await fs.readFile(collision, 'utf8'), 'user backup');
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  await noTemporaryFiles(f.root);
});

test('an edit racing the backup move is restored without replacing its contents and the new subtitles use an alternate', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  const io = { ...fs, rename: async (source, destination) => {
    if (source === f.normal) await fs.writeFile(source, 'manual concurrent edit');
    return fs.rename(source, destination);
  } };
  const revision = revisedRecord(f.record);
  const result = await saveKoreanSubtitle(revision, { generatedSubtitleFiles, io });
  assert.equal(result.status, 'saved');
  assert.notEqual(result.path, f.normal);
  assert.equal(result.updated, undefined);
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'manual concurrent edit');
  assert.equal(await fs.readFile(result.path, 'utf8'), subtitleText(revision, { language: 'ko' }));
  const backups = (await fs.readdir(f.root)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, backups[0]), 'utf8'), 'manual concurrent edit');
  await noTemporaryFiles(f.root);
});

test('a new canonical subtitle created between backup and publication is never overwritten', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  let raced = false;
  const io = { ...fs, link: async (source, destination) => {
    if (!raced && destination === f.normal && source.endsWith('.tmp')) { raced = true; await fs.writeFile(destination, 'another application wrote this'); }
    return fs.link(source, destination);
  } };
  const result = await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, io });
  assert.equal(result.status, 'saved');
  assert.notEqual(result.path, f.normal);
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'another application wrote this');
  const backups = (await fs.readdir(f.root)).filter(name => name.endsWith('.bak'));
  assert.deepEqual(await fs.readFile(path.join(f.root, backups[0])), f.bytes);
  await noTemporaryFiles(f.root);
});

test('cancellation before or after updated publication restores the former canonical file and preserves backup bytes', async t => {
  for (const phase of ['backup', 'publish']) {
    const f = await fixture(t);
    const generatedSubtitleFiles = await ownedPrevious(f);
    const controller = new AbortController();
    const io = { ...fs, rename: async (source, destination) => {
      await fs.rename(source, destination);
      if (phase === 'backup' && source === f.normal) controller.abort();
    }, link: async (source, destination) => {
      await fs.link(source, destination);
      if (phase === 'publish' && destination === f.normal && source.endsWith('.tmp')) controller.abort();
    } };
    assert.equal(await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, signal: controller.signal, io }), null);
    assert.deepEqual(await fs.readFile(f.normal), f.bytes, phase);
    const backups = (await fs.readdir(f.root)).filter(name => name.endsWith('.bak'));
    assert.ok(backups.length >= 1);
    assert.ok((await Promise.all(backups.map(name => fs.readFile(path.join(f.root, name))))).some(bytes => bytes.equals(f.bytes)));
    await noTemporaryFiles(f.root);
  }
});

test('a failed update restores the canonical original and returns the retained backup location', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  const io = { ...fs, link: async (source, destination) => {
    if (destination === f.normal && source.endsWith('.tmp')) throw Object.assign(new Error('fixture denied publish'), { code: 'EACCES' });
    return fs.link(source, destination);
  } };
  const result = await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, io });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'EACCES');
  assert.deepEqual(await fs.readFile(f.normal), f.bytes);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  await noTemporaryFiles(f.root);
});

test('concurrent editing after a hard-linked publication never saves altered bytes under the expected generated hash', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  const io = { ...fs, link: async (source, destination) => {
    await fs.link(source, destination);
    if (destination === f.normal && source.endsWith('.tmp')) await fs.writeFile(destination, 'user edited the new subtitle');
  } };
  const result = await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, io });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'SUBTITLE_CHANGED');
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'user edited the new subtitle');
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  await noTemporaryFiles(f.root);
});

test('trusted canonical updates work on exFAT-like filesystems using exclusive copy', async t => {
  const f = await fixture(t);
  const generatedSubtitleFiles = await ownedPrevious(f);
  const io = { ...fs, link: async () => { throw Object.assign(new Error('fixture unsupported hard link'), { code: 'ENOTSUP' }); },
    copyFile: async (source, destination, flags) => { assert.equal(flags, COPYFILE_EXCL); await fs.copyFile(source, destination, flags); } };
  const result = await saveKoreanSubtitle(revisedRecord(f.record), { generatedSubtitleFiles, io });
  assert.equal(result.updated, true);
  assert.equal(result.path, f.normal);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  await noTemporaryFiles(f.root);
});

test('writes Korean UTF-8 SRT beside the actual source with exact times and a byte hash, then reuses it', async t => {
  const f = await fixture(t);
  const saved = await saveKoreanSubtitle(f.record);
  assert.deepEqual(saved, { status: 'saved', path: f.normal, sha256: crypto.createHash('sha256').update(f.bytes).digest('hex') });
  assert.deepEqual(await fs.readFile(f.normal), f.bytes);
  assert.match(f.bytes.toString('utf8'), /00:00:00,125 --> 00:00:02,375/);
  assert.match(f.bytes.toString('utf8'), /00:00:03,750 --> 00:00:06,025/);
  const stat = await fs.stat(f.normal);
  const reused = await saveKoreanSubtitle(f.record);
  assert.deepEqual(reused, { ...saved, status: 'unchanged' });
  assert.equal((await fs.stat(f.normal)).ino, stat.ino);
  assert.deepEqual(await fs.readFile(f.videoPath, 'utf8'), 'owned neutral media fixture');
  await noTemporaryFiles(f.root);
});

test('preserves a different subtitle, uses a deterministic alternate and reuses that alternate', async t => {
  const f = await fixture(t);
  const existing = 'User-created Korean subtitles\r\n';
  await fs.writeFile(f.normal, existing);
  const saved = await saveKoreanSubtitle(f.record);
  assert.equal(saved.status, 'saved');
  assert.equal(saved.path, f.alternate);
  assert.equal(await fs.readFile(f.normal, 'utf8'), existing);
  assert.deepEqual(await fs.readFile(f.alternate), f.bytes);
  assert.equal((await saveKoreanSubtitle(f.record)).status, 'unchanged');
  assert.equal((await fs.readdir(f.root)).filter(name => name.endsWith('.srt')).length, 2);
  await noTemporaryFiles(f.root);
});

test('bounded conflicts fail without changing existing files', async t => {
  const f = await fixture(t);
  const targets = [f.normal, f.alternate, ...Array.from({ length: 8 }, (_, index) =>
    path.join(f.root, '언어 연습.videorandom-0123456789ab-' + (index + 2) + '.ko.srt'))];
  await Promise.all(targets.map((target, index) => fs.writeFile(target, 'preserved-' + index)));
  const result = await saveKoreanSubtitle(f.record);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'NAME_CONFLICT');
  for (const [index, target] of targets.entries()) assert.equal(await fs.readFile(target, 'utf8'), 'preserved-' + index);
  await noTemporaryFiles(f.root);
});

test('incomplete, untranslated, failed and cancelled records never write; valid partial translation does', async t => {
  const f = await fixture(t);
  const abort = new AbortController(); abort.abort();
  const cases = [
    { ...f.record, status: 'failed' }, { ...f.record, status: 'cancelled' }, { ...f.record, status: 'running' },
    { ...f.record, subtitleLanguage: 'original' }, { ...f.record, subtitleError: 'translation did not finish' },
    { ...f.record, subtitleTranslation: [] }, { ...f.record, subtitleTranslation: [f.record.subtitleTranslation[0]] },
    { ...f.record, subtitleTranslation: f.record.subtitleTranslation.map(cue => ({ ...cue, start: cue.start + 1 })) },
    { ...f.record, subtitleTranslation: f.record.subtitleTranslation.map(cue => ({ ...cue, text: '   ' })) }
  ];
  for (const record of cases) assert.equal(await saveKoreanSubtitle(record), null);
  assert.equal(await saveKoreanSubtitle(f.record, { signal: abort.signal }), null);
  assert.deepEqual(await fs.readdir(f.root), [path.basename(f.videoPath)]);
  const result = await saveKoreanSubtitle({ ...f.record, status: 'partial', error: 'An unrelated representative frame was missing' });
  assert.equal(result.status, 'saved');
});

test('write denial and missing source return warnings without touching existing files', async t => {
  const f = await fixture(t);
  const io = { ...fs, open: async (target, flags, ...rest) => {
    if (flags === 'wx') throw Object.assign(new Error('fixture permission denial'), { code: 'EACCES' });
    return fs.open(target, flags, ...rest);
  } };
  const denied = await saveKoreanSubtitle(f.record, { io });
  assert.equal(denied.status, 'failed'); assert.equal(denied.code, 'EACCES');
  assert.match(denied.error, /SRT를 직접 저장/);
  const missing = await saveKoreanSubtitle({ ...f.record, path: path.join(f.root, 'missing.mp4') });
  assert.equal(missing.status, 'failed'); assert.equal(missing.code, 'ENOENT');
  await noTemporaryFiles(f.root);
});

test('disk full during temporary write cleans only its own temporary file', async t => {
  const f = await fixture(t);
  const userFile = path.join(f.root, 'user-notes.tmp');
  await fs.writeFile(userFile, 'user file');
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] !== 'wx') return handle;
    return { writeFile: async () => { await handle.writeFile('incomplete fixture'); throw Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' }); },
      close: () => handle.close(), sync: () => handle.sync(), stat: () => handle.stat() };
  } };
  const result = await saveKoreanSubtitle(f.record, { io });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'ENOSPC');
  assert.equal(await fs.readFile(userFile, 'utf8'), 'user file');
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.startsWith('.videorandom-subtitle-')), []);
  await assert.rejects(fs.stat(f.normal), { code: 'ENOENT' });
});

test('exFAT-like lack of hard links falls back to exclusive copy and keeps user conflicts', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.normal, 'user subtitle');
  const copied = [];
  const io = { ...fs, link: async () => { throw Object.assign(new Error('fixture unsupported hard link'), { code: 'EPERM' }); },
    copyFile: async (source, destination, flags) => { assert.equal(flags, COPYFILE_EXCL); copied.push(destination); return fs.copyFile(source, destination, flags); } };
  const result = await saveKoreanSubtitle(f.record, { io });
  assert.equal(result.status, 'saved'); assert.equal(result.path, f.alternate);
  assert.deepEqual(copied, [f.normal, f.alternate]);
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'user subtitle');
  assert.deepEqual(await fs.readFile(f.alternate), f.bytes);
  await noTemporaryFiles(f.root);
});

test('copy failure preserves preexisting files and cleans temporary source', async t => {
  const f = await fixture(t);
  const io = { ...fs, link: async () => { throw Object.assign(new Error('fixture unsupported hard link'), { code: 'ENOTSUP' }); },
    copyFile: async () => { throw Object.assign(new Error('fixture share became read-only'), { code: 'EROFS' }); } };
  const result = await saveKoreanSubtitle(f.record, { io });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'EROFS');
  await noTemporaryFiles(f.root);
  await assert.rejects(fs.stat(f.normal), { code: 'ENOENT' });
});

test('cancellation during publishing removes only its own newly published subtitle', async t => {
  const f = await fixture(t);
  for (const fallback of [false, true]) {
    const controller = new AbortController();
    const io = { ...fs, link: async (source, destination) => {
      if (fallback) throw Object.assign(new Error('fixture unsupported hard link'), { code: 'ENOTSUP' });
      await fs.link(source, destination); controller.abort();
    }, copyFile: async (...args) => { await fs.copyFile(...args); controller.abort(); } };
    assert.equal(await saveKoreanSubtitle(f.record, { signal: controller.signal, io }), null);
    await assert.rejects(fs.stat(f.normal), { code: 'ENOENT' });
    await noTemporaryFiles(f.root);
  }
});

test('concurrent saves do not overwrite or duplicate the same subtitle', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => saveKoreanSubtitle(f.record)));
  assert.equal(results.filter(result => result.status === 'saved').length, 1);
  assert.equal(results.filter(result => result.status === 'unchanged').length, 4);
  assert.ok(results.every(result => result.path === f.normal));
  assert.deepEqual(await fs.readFile(f.normal), f.bytes);
  await noTemporaryFiles(f.root);
});

test('file-symlink metadata is never followed for source or existing destination, without needing OS symlink privileges', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.normal, 'simulated symlink target contents');
  const symbolic = stat => Object.assign(stat, { isSymbolicLink: () => true });
  const sourceIO = { ...fs, lstat: async target => target === f.videoPath ? symbolic(await fs.lstat(target)) : fs.lstat(target) };
  const source = await saveKoreanSubtitle(f.record, { io: sourceIO });
  assert.equal(source.status, 'failed'); assert.equal(source.code, 'UNSAFE_PATH');
  const destinationIO = { ...fs, lstat: async target => target === f.normal ? symbolic(await fs.lstat(target)) : fs.lstat(target),
    open: async (target, ...args) => { assert.notEqual(target, f.normal, 'An existing symlink must not be opened for comparison'); return fs.open(target, ...args); } };
  const destination = await saveKoreanSubtitle(f.record, { io: destinationIO });
  assert.equal(destination.status, 'saved'); assert.equal(destination.path, f.alternate);
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'simulated symlink target contents');
  await noTemporaryFiles(f.root);
});

test('non-absolute and symlinked source paths are rejected; existing subtitle symlinks are preserved', async t => {
  const f = await fixture(t);
  const relative = await saveKoreanSubtitle({ ...f.record, path: 'relative-video.mp4' });
  assert.equal(relative.status, 'failed'); assert.equal(relative.code, 'UNSAFE_PATH');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-outside-'));
  t.after(async () => {
    assert.equal(path.dirname(outside), path.resolve(os.tmpdir()));
    assert.ok(path.basename(outside).startsWith('videorandom-sidecar-outside-'));
    await fs.rm(outside, { recursive: true, force: true });
  });
  const sourceLink = path.join(f.root, 'linked.mp4');
  const directoryLink = path.join(f.root, 'linked-folder');
  const outsideFile = path.join(outside, 'user-subtitle.srt');
  await fs.writeFile(outsideFile, 'outside user subtitle');
  // Directory junctions need no developer-mode symlink privilege on Windows.
  await fs.symlink(f.root, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  const junction = await saveKoreanSubtitle({ ...f.record, path: path.join(directoryLink, path.basename(f.videoPath)) });
  assert.equal(junction.status, 'failed'); assert.equal(junction.code, 'UNSAFE_PATH');
  try {
    await fs.symlink(f.videoPath, sourceLink, 'file');
    await fs.symlink(outsideFile, f.normal, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('File symlink privileges unavailable; absolute-path and directory-junction rejection verified.'); return; }
    throw error;
  }
  for (const source of [sourceLink, path.join(directoryLink, path.basename(f.videoPath))]) {
    const result = await saveKoreanSubtitle({ ...f.record, path: source });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'UNSAFE_PATH');
  }
  const saved = await saveKoreanSubtitle(f.record);
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  assert.equal((await fs.lstat(f.normal)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside user subtitle');
  await noTemporaryFiles(f.root);
});
