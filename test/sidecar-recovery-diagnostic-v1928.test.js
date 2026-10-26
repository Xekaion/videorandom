const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { saveKoreanSubtitle, sanitizeSidecarDiagnostic } = require('../lib/subtitle-sidecar');

const PRIVATE = 'DO_NOT_LOG_PRIVATE_FILESYSTEM_ERROR';
const error = code => Object.assign(new Error(PRIVATE), { code, stack: PRIVATE, path: PRIVATE });
async function fixture(t) {
  const allocated = await fs.mkdtemp(path.join(os.tmpdir(), 'videorandom-sidecar-diagnostic-v1928-'));
  const root = await fs.realpath(allocated), video = path.join(root, '합성 열차.mp4');
  await fs.writeFile(video, 'Owned neutral metadata fixture. Not decoded as media.');
  const transcript = [{ id: 'neutral-1', start: 0, end: 2, text: 'Synthetic train notice.' }];
  const record = { id: 'a'.repeat(32), status: 'completed', path: video, transcript, subtitleLanguage: 'ko',
    subtitleTranslation: [{ ...transcript[0], text: '합성 열차 안내입니다.' }] };
  const candidates = Array.from({ length: 10 }, (_, index) => path.join(root,
    '합성 열차' + (index === 0 ? '' : '.videorandom-' + 'a'.repeat(12) + (index === 1 ? '' : '-' + index)) + '.ko.srt'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(allocated)), path.resolve(os.tmpdir()));
    assert(path.basename(allocated).startsWith('videorandom-sidecar-diagnostic-v1928-'));
    await fs.rm(allocated, { recursive: true, force: true });
  });
  return { root, video, record, candidates };
}
function metadata(result, expected) {
  assert.equal(result.status, 'failed');
  assert.deepEqual(sanitizeSidecarDiagnostic(result), expected);
  assert.equal(JSON.stringify(sanitizeSidecarDiagnostic(result)).includes(PRIVATE), false);
  assert.equal(result.error.includes(PRIVATE), false);
}
async function noTemps(root) {
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.videorandom-subtitle-')), false);
}

test('the shared sidecar diagnostic sanitizer exposes only bounded operation enums and attempt counts', () => {
  const valid = { saveStage: 'publish-copy', pathClass: 'subtitle-candidate', attemptedNames: 2 };
  assert.deepEqual(sanitizeSidecarDiagnostic({ ...valid, path: PRIVATE, stack: PRIVATE, message: PRIVATE, other: PRIVATE }), valid);
  for (const value of [null, [], 'bad', { saveStage: PRIVATE, pathClass: PRIVATE, attemptedNames: 11 },
    { saveStage: {}, pathClass: {}, attemptedNames: -1 }, { attemptedNames: 1.5 }, { attemptedNames: '1' }]) {
    assert.deepEqual(sanitizeSidecarDiagnostic(value), {});
  }
  assert.deepEqual(sanitizeSidecarDiagnostic({ attemptedNames: 0 }), { attemptedNames: 0 });
  assert.deepEqual(sanitizeSidecarDiagnostic({ attemptedNames: 10 }), { attemptedNames: 10 });
});

for (const sourceParent of [false, true]) test(`source ${sourceParent ? 'parent' : 'file'} failure is identified before any subtitle candidate is attempted`, async t => {
  const f = await fixture(t), failing = sourceParent ? f.root : f.video;
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, lstat: async filename => {
    if (filename === failing) throw error('EACCES'); return fs.lstat(filename);
  } } });
  metadata(result, { saveStage: 'source-check', pathClass: sourceParent ? 'source-parent' : 'source-file', attemptedNames: 0 });
  assert.equal(await fs.readFile(f.video, 'utf8'), 'Owned neutral metadata fixture. Not decoded as media.');
  await noTemps(f.root);
});

test('candidate inspection failure is separate from temporary creation and publication', async t => {
  const f = await fixture(t);
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, lstat: async filename => {
    if (filename === f.candidates[0]) throw error('EACCES'); return fs.lstat(filename);
  } } });
  metadata(result, { saveStage: 'candidate-check', pathClass: 'subtitle-candidate', attemptedNames: 1 }); await noTemps(f.root);
});

test('EISDIR while opening the owned random temporary file does not authorize an alternate subtitle name', async t => {
  const f = await fixture(t); let publishes = 0;
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, open: async (filename, flags, ...args) => {
    if (flags === 'wx') throw error('EISDIR'); return fs.open(filename, flags, ...args);
  }, link: async () => { publishes++; } } });
  metadata(result, { saveStage: 'temporary-open', pathClass: 'temporary-file', attemptedNames: 1 });
  assert.equal(result.systemCode, 'EISDIR'); assert.equal(publishes, 0); await noTemps(f.root);
});

for (const [method, stage, code] of [['writeFile', 'temporary-write', 'ENOSPC'], ['sync', 'temporary-sync', 'EIO'],
  ['stat', 'temporary-check', 'EIO'], ['close', 'temporary-close', 'EIO']]) {
  test(`${method} failure retains its actual temporary operation even after closing and cleanup`, async t => {
    const f = await fixture(t);
    const result = await saveKoreanSubtitle(f.record, { io: { ...fs, open: async (filename, flags, ...args) => {
      const handle = await fs.open(filename, flags, ...args);
      if (flags !== 'wx') return handle;
      return Object.fromEntries(['writeFile', 'sync', 'stat', 'close'].map(name => [name, async (...values) => {
        if (name === method) { if (name === 'close') await handle.close(); throw error(code); }
        return handle[name](...values);
      }]));
    } } });
    metadata(result, { saveStage: stage, pathClass: 'temporary-file', attemptedNames: 1 });
    assert.equal(result.systemCode, code); await noTemps(f.root);
  });
}

test('unconfirmed EISDIR at hard-link publication stays failed at that exact operation without a blind retry', async t => {
  const f = await fixture(t), attempts = [];
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async (_, candidate) => { attempts.push(candidate); throw error('EISDIR'); } } });
  metadata(result, { saveStage: 'publish-link', pathClass: 'subtitle-candidate', attemptedNames: 1 });
  assert.deepEqual(attempts, [f.candidates[0]]); await noTemps(f.root);
});

test('exclusive-copy failure records the actual alternate attempt after preserving an occupied directory', async t => {
  const f = await fixture(t); await fs.mkdir(f.candidates[0]); await fs.writeFile(path.join(f.candidates[0], 'preserved.txt'), 'preserved');
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async () => { throw error('ENOTSUP'); },
    copyFile: async () => { throw error('ENOSPC'); } } });
  metadata(result, { saveStage: 'publish-copy', pathClass: 'subtitle-candidate', attemptedNames: 2 });
  assert.equal(await fs.readFile(path.join(f.candidates[0], 'preserved.txt'), 'utf8'), 'preserved'); await noTemps(f.root);
});

test('owned subtitle backup failure preserves the previous generation and names the backup operation', async t => {
  const f = await fixture(t), first = await saveKoreanSubtitle(f.record);
  const before = await fs.readFile(first.path);
  const revised = { ...f.record, subtitleTranslation: f.record.subtitleTranslation.map(cue => ({ ...cue, text: '다시 검수한 합성 열차 안내입니다.' })) };
  const result = await saveKoreanSubtitle(revised, { generatedSubtitleFiles: [{ path: first.path, sha256: first.sha256 }],
    io: { ...fs, rename: async () => { throw error('EACCES'); } } });
  metadata(result, { saveStage: 'owned-update', pathClass: 'owned-backup', attemptedNames: 1 });
  assert.deepEqual(await fs.readFile(first.path), before); await noTemps(f.root);
});

test('ten occupied names stay a bounded name-selection failure with no new fallback scheme', async t => {
  const f = await fixture(t); await Promise.all(f.candidates.map(candidate => fs.mkdir(candidate)));
  const result = await saveKoreanSubtitle(f.record);
  metadata(result, { saveStage: 'name-selection', pathClass: 'subtitle-candidate', attemptedNames: 10 });
  assert.equal(result.code, 'NAME_CONFLICT');
  assert((await Promise.all(f.candidates.map(candidate => fs.lstat(candidate)))).every(stat => stat.isDirectory())); await noTemps(f.root);
});

test('a confirmed directory race at publication still uses the existing bounded alternate and preserves directory contents', async t => {
  const f = await fixture(t); let raced = false;
  const result = await saveKoreanSubtitle(f.record, { io: { ...fs, link: async (source, destination) => {
    if (!raced) {
      raced = true; await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'preserved.txt'), 'preserved'); throw error('EISDIR');
    }
    return fs.link(source, destination);
  } } });
  assert.equal(result.status, 'saved'); assert.equal(result.path, f.candidates[1]);
  assert.deepEqual(sanitizeSidecarDiagnostic(result), {}, 'failure diagnostics do not become success assertions');
  assert.equal(await fs.readFile(path.join(f.candidates[0], 'preserved.txt'), 'utf8'), 'preserved'); await noTemps(f.root);
});
