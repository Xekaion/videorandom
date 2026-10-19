const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { COPYFILE_EXCL } = require('node:fs').constants;
const { saveKoreanSubtitle } = require('../lib/subtitle-sidecar');
const { subtitleText } = require('../lib/subtitle-utils');

const id = '123456789abcdef0123456789abcdef0';
const failure = code => Object.assign(new Error('PRIVATE_SYNTHETIC_FILESYSTEM_ERROR'), { code });

async function fixture(t, { partial = false, count = 3 } = {}) {
  const allocated = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-collisions-v1914-'));
  const root = await fs.realpath(allocated), video = path.join(root, '합성 안내.mp4');
  await fs.writeFile(video, 'Owned neutral source fixture. No media decoding is used.');
  const source = Array.from({ length: count }, (_, index) => ({ id: `owned-${index}`, start: index * 3 + 0.125,
    end: index * 3 + 2.375, text: '合成の列車案内です。' }));
  const translated = source.map(cue => ({ ...cue, text: '합성 열차 안내입니다.' }));
  const record = { id, path: video, name: path.basename(video), status: partial ? 'partial' : 'completed', transcript: source };
  if (partial) {
    record.subtitleTranslationPartial = translated;
    record.subtitleTranslationProgress = { version: 1, language: 'ko', totalCues: count, completedCues: count,
      complete: false, translationComplete: true, sourceComplete: false,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id, cue.start, cue.end, cue.text]))).digest('hex') };
  } else { record.subtitleLanguage = 'ko'; record.subtitleTranslation = translated; }
  const extension = partial ? '.ko.partial.srt' : '.ko.srt';
  const candidates = Array.from({ length: 10 }, (_, index) => path.join(root,
    '합성 안내' + (index === 0 ? '' : '.videorandom-' + id.slice(0, 12) + (index === 1 ? '' : '-' + index)) + extension));
  const bytes = Buffer.from(subtitleText(record, { language: 'ko', partial }), 'utf8');
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(allocated)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(allocated).startsWith('videorandom-sidecar-collisions-v1914-'));
    await fs.rm(allocated, { recursive: true, force: true });
  });
  return { root, video, record, bytes, candidates, normal: candidates[0], alternate: candidates[1] };
}

async function occupiedDirectory(target) {
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'preserved-user-file.txt'), 'Preserved directory content');
}
async function assertDirectory(target) {
  assert.equal((await fs.lstat(target)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(target, 'preserved-user-file.txt'), 'utf8'), 'Preserved directory content');
}
async function noTemporaryFiles(root) {
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.videorandom-subtitle-') && name.endsWith('.tmp')), false);
}

test('a directory at the normal SRT name is preserved and a validated alternate subtitle is saved and reused', async t => {
  const f = await fixture(t); await occupiedDirectory(f.normal);
  const published = [];
  const io = { ...fs, open: async (filename, ...args) => {
    assert.notEqual(filename, f.normal, 'A known directory is never opened as subtitle text');
    return fs.open(filename, ...args);
  }, link: async (source, destination) => {
    assert.notEqual(destination, f.normal, 'A known directory is never a publication target');
    published.push(destination); return fs.link(source, destination);
  }, rename: async (source, destination) => {
    assert.notEqual(source, f.normal, 'A directory cannot become a canonical subtitle backup');
    return fs.rename(source, destination);
  } };
  const saved = await saveKoreanSubtitle(f.record, { io, generatedSubtitleFiles: [{ path: f.normal, sha256: 'a'.repeat(64) }] });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  assert.deepEqual(await fs.readFile(saved.path), f.bytes);
  assert.deepEqual(published, [f.alternate]);
  await assertDirectory(f.normal);
  const reused = await saveKoreanSubtitle(f.record, { io });
  assert.equal(reused.status, 'unchanged'); assert.equal(reused.path, f.alternate);
  assert.deepEqual(published, [f.alternate]);
  await noTemporaryFiles(f.root);
});

test('mixed directory and foreign-file collisions use the next bounded filename without changing occupied names', async t => {
  const f = await fixture(t);
  await occupiedDirectory(f.normal); await occupiedDirectory(f.alternate);
  await fs.writeFile(f.candidates[2], 'User-authored complete subtitles');
  const result = await saveKoreanSubtitle(f.record);
  assert.equal(result.status, 'saved'); assert.equal(result.path, f.candidates[3]);
  await assertDirectory(f.normal); await assertDirectory(f.alternate);
  assert.equal(await fs.readFile(f.candidates[2], 'utf8'), 'User-authored complete subtitles');
  assert.deepEqual(await fs.readFile(result.path), f.bytes);
  await noTemporaryFiles(f.root);
});

test('a reviewed 129 of 129 source-review partial result can save separately without reanalysis or changing an existing complete SRT', async t => {
  const f = await fixture(t, { partial: true, count: 129 });
  const complete = path.join(f.root, '합성 안내.ko.srt');
  await fs.writeFile(complete, 'User complete player subtitles'); await occupiedDirectory(f.normal);
  const before = JSON.stringify(f.record), saved = await saveKoreanSubtitle(f.record);
  assert.equal(saved.status, 'saved'); assert.equal(saved.partial, true); assert.equal(saved.path, f.alternate);
  assert.deepEqual(await fs.readFile(saved.path), f.bytes);
  assert.equal((f.bytes.toString('utf8').match(/ --> /g) || []).length, 129);
  assert.equal(await fs.readFile(complete, 'utf8'), 'User complete player subtitles');
  assert.equal(JSON.stringify(f.record), before);
  await assertDirectory(f.normal); await noTemporaryFiles(f.root);
});

test('unsupported hard links still use exclusive copy to the alternate while a known directory is untouched', async t => {
  const f = await fixture(t); await occupiedDirectory(f.normal);
  const copied = [];
  const saved = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async () => { throw failure('ENOTSUP'); },
    copyFile: async (source, destination, flags) => { assert.equal(flags, COPYFILE_EXCL); copied.push(destination); return fs.copyFile(source, destination, flags); } } });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  assert.deepEqual(copied, [f.alternate]);
  await assertDirectory(f.normal); assert.deepEqual(await fs.readFile(saved.path), f.bytes); await noTemporaryFiles(f.root);
});

for (const copy of [false, true]) test(`a directory racing ${copy ? 'exclusive copy' : 'hard-link publication'} is confirmed before trying an alternate`, async t => {
  const f = await fixture(t); let raced = false;
  const io = { ...fs, link: async (source, destination) => {
    if (copy) throw failure('ENOTSUP');
    if (!raced && destination === f.normal) { raced = true; await occupiedDirectory(destination); throw failure('EISDIR'); }
    return fs.link(source, destination);
  }, copyFile: async (source, destination, flags) => {
    assert.equal(flags, COPYFILE_EXCL);
    if (!raced && destination === f.normal) { raced = true; await occupiedDirectory(destination); throw failure('EISDIR'); }
    return fs.copyFile(source, destination, flags);
  } };
  const saved = await saveKoreanSubtitle(f.record, { io });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  await assertDirectory(f.normal); assert.deepEqual(await fs.readFile(saved.path), f.bytes); await noTemporaryFiles(f.root);
});

test('a file-to-directory race during identical-content comparison preserves both generations and saves an alternate', async t => {
  const f = await fixture(t); await fs.writeFile(f.normal, f.bytes);
  const movedByOtherProcess = path.join(f.root, 'other-process-preserved.srt'); let raced = false;
  const saved = await saveKoreanSubtitle(f.record, { io: { ...fs, open: async (filename, flags, ...rest) => {
    if (!raced && filename === f.normal && flags === 'r') {
      raced = true; await fs.rename(filename, movedByOtherProcess); await occupiedDirectory(filename); throw failure('EISDIR');
    }
    return fs.open(filename, flags, ...rest);
  } } });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  await assertDirectory(f.normal); assert.deepEqual(await fs.readFile(movedByOtherProcess), f.bytes);
  assert.deepEqual(await fs.readFile(saved.path), f.bytes); await noTemporaryFiles(f.root);
});

test('a directory created after an owned canonical backup is preserved together with the exact backup bytes', async t => {
  const f = await fixture(t), original = await saveKoreanSubtitle(f.record);
  const revised = { ...f.record, subtitleTranslation: f.record.subtitleTranslation.map(cue => ({ ...cue, text: '새로 검수한 합성 자막입니다.' })) };
  let raced = false;
  const saved = await saveKoreanSubtitle(revised, { generatedSubtitleFiles: [{ path: original.path, sha256: original.sha256 }],
    io: { ...fs, link: async (source, destination) => {
      if (!raced && source.endsWith('.tmp') && destination === f.normal) { raced = true; await occupiedDirectory(destination); throw failure('EISDIR'); }
      return fs.link(source, destination);
    } } });
  assert.equal(saved.status, 'saved'); assert.equal(saved.path, f.alternate);
  await assertDirectory(f.normal);
  const backups = (await fs.readdir(f.root)).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.deepEqual(await fs.readFile(path.join(f.root, backups[0])), f.bytes);
  assert.equal(await fs.readFile(saved.path, 'utf8'), subtitleText(revised, { language: 'ko' }));
  await noTemporaryFiles(f.root);
});

for (const occupied of [false, true]) test(`EISDIR without a confirmed non-file collision remains a failure (${occupied ? 'regular file exists' : 'name absent'})`, async t => {
  const f = await fixture(t);
  if (occupied) await fs.writeFile(f.normal, 'Preserved foreign subtitles');
  const calls = [];
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async (_, destination) => {
    calls.push(destination); throw failure('EISDIR');
  } } });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'EISDIR'); assert.equal(result.systemCode, 'EISDIR');
  assert.deepEqual(calls, [f.normal]);
  if (occupied) assert.equal(await fs.readFile(f.normal, 'utf8'), 'Preserved foreign subtitles');
  else await assert.rejects(fs.lstat(f.normal), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(f.alternate), { code: 'ENOENT' }); await noTemporaryFiles(f.root);
});

test('EISDIR while creating the random temporary file is not treated as a candidate name collision', async t => {
  const f = await fixture(t);
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, open: async (filename, flags, ...rest) => {
    if (flags === 'wx') throw failure('EISDIR');
    return fs.open(filename, flags, ...rest);
  } } });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'EISDIR');
  assert.deepEqual(await fs.readdir(f.root), [path.basename(f.video)]);
});

for (const code of ['EACCES', 'ENOSPC', 'EPERM', 'EROFS', 'EIO']) test(`a genuine ${code} write error after skipping a directory is retained without a false success`, async t => {
  const f = await fixture(t); await occupiedDirectory(f.normal);
  const attempted = [];
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async () => { throw failure('ENOTSUP'); },
    copyFile: async (_, destination, flags) => { assert.equal(flags, COPYFILE_EXCL); attempted.push(destination); throw failure(code); } } });
  assert.equal(result.status, 'failed'); assert.equal(result.code, code); assert.equal(result.systemCode, code);
  assert.deepEqual(attempted, [f.alternate]);
  assert.equal(result.error.includes('PRIVATE_'), false);
  await assertDirectory(f.normal); await assert.rejects(fs.lstat(f.alternate), { code: 'ENOENT' }); await noTemporaryFiles(f.root);
});

test('ten occupied directories exhaust the fixed candidate list without creating a temporary file or changing directories', async t => {
  const f = await fixture(t); await Promise.all(f.candidates.map(occupiedDirectory));
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, open: async () => { assert.fail('No file should be opened when all candidate names are directories'); } } });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'NAME_CONFLICT');
  await Promise.all(f.candidates.map(assertDirectory)); await noTemporaryFiles(f.root);
});

test('an original source directory is rejected rather than creating subtitles beside a different source', async t => {
  const f = await fixture(t), directorySource = path.join(f.root, 'source-is-a-directory.mp4');
  await occupiedDirectory(directorySource);
  const result = await saveKoreanSubtitle({ ...f.record, path: directorySource });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'UNSAFE_PATH');
  await assertDirectory(directorySource); await assert.rejects(fs.lstat(f.normal), { code: 'ENOENT' }); await noTemporaryFiles(f.root);
});

test('a symlink-marked destination is preserved without opening or publishing over its target', async t => {
  const f = await fixture(t); await fs.writeFile(f.normal, 'Preserved simulated symlink target');
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, lstat: async filename => {
    const stat = await fs.lstat(filename);
    return filename === f.normal ? Object.assign(stat, { isSymbolicLink: () => true }) : stat;
  }, open: async (filename, ...rest) => {
    assert.notEqual(filename, f.normal); return fs.open(filename, ...rest);
  } } });
  assert.equal(result.status, 'saved'); assert.equal(result.path, f.alternate);
  assert.equal(await fs.readFile(f.normal, 'utf8'), 'Preserved simulated symlink target'); await noTemporaryFiles(f.root);
});

test('cancelling while an occupied directory is inspected leaves it untouched without creating another file', async t => {
  const f = await fixture(t); await occupiedDirectory(f.normal); const controller = new AbortController();
  const result = await saveKoreanSubtitle(f.record, { signal: controller.signal, io: { ...fs, lstat: async filename => {
    const stat = await fs.lstat(filename); if (filename === f.normal) controller.abort(); return stat;
  } } });
  assert.equal(result, null); await assertDirectory(f.normal); await assert.rejects(fs.lstat(f.alternate), { code: 'ENOENT' });
  await noTemporaryFiles(f.root);
});

test('cancelling after alternate publication removes only the newly owned subtitle and preserves the occupied directory', async t => {
  const f = await fixture(t); await occupiedDirectory(f.normal); const controller = new AbortController();
  const result = await saveKoreanSubtitle(f.record, { signal: controller.signal, io: { ...fs, link: async (source, destination) => {
    await fs.link(source, destination); controller.abort();
  } } });
  assert.equal(result, null); await assertDirectory(f.normal); await assert.rejects(fs.lstat(f.alternate), { code: 'ENOENT' });
  await noTemporaryFiles(f.root);
});
