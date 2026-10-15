const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { COPYFILE_EXCL } = require('fs').constants;
const { subtitleText } = require('./subtitle-utils');

const MAX_CANDIDATES = 10;

function samePath(left, right) {
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalized(path.resolve(left)) === normalized(path.resolve(right));
}

function unsafePath() {
  const error = new Error('영상 파일 또는 폴더가 심볼릭 링크이거나 안전하게 확인되지 않았습니다.');
  error.code = 'UNSAFE_PATH';
  return error;
}

async function verifySource(io, sourcePath, expectedSource) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) throw unsafePath();
  const resolved = path.resolve(sourcePath);
  const parent = path.dirname(resolved);
  // Check every directory, including junctions on Windows. Realpath alone
  // would silently follow them and could write outside the selected folder.
  let directory = parent;
  while (true) {
    const stat = await io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
    const next = path.dirname(directory);
    if (next === directory) break;
    directory = next;
  }
  const stat = await io.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw unsafePath();
  const canonical = await io.realpath(resolved);
  const canonicalParent = await io.realpath(parent);
  if (!samePath(path.dirname(canonical), canonicalParent) || !samePath(canonical, resolved)
    || (expectedSource && (!samePath(canonical, expectedSource.path) || stat.dev !== expectedSource.dev || stat.ino !== expectedSource.ino))) throw unsafePath();
  return { path: canonical, parent: canonicalParent, dev: stat.dev, ino: stat.ino };
}

async function identicalFile(io, candidate, bytes) {
  let stat;
  try { stat = await io.lstat(candidate); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // Existing symlinks (even dangling ones) are occupied names, never targets.
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== bytes.length) return false;
  const handle = await io.open(candidate, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return false;
    const contents = await handle.readFile();
    return contents.equals(bytes);
  } finally { await handle.close(); }
}

function failed(error, target) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SAVE_FAILED';
  const reason = code === 'UNSAFE_PATH' ? '영상 파일과 폴더의 실제 경로를 확인할 수 없습니다.'
    : code === 'NAME_CONFLICT' ? '기존 자막을 보존하기 위해 사용할 수 있는 새 파일 이름을 찾지 못했습니다.'
      : ['EACCES', 'EPERM', 'EROFS'].includes(code) ? '영상 폴더에 자막을 저장할 권한이 없습니다.'
        : code === 'ENOSPC' ? '영상 폴더의 저장 공간이 부족합니다.'
          : ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code) ? '이 저장 장치에서 자막 파일을 안전하게 저장할 수 없습니다.'
            : code === 'ENOENT' ? '영상 파일 또는 폴더를 찾을 수 없습니다.'
              : '영상 폴더에 한국어 자막 파일을 저장하지 못했습니다.';
  return { status: 'failed', path: target || '', error: reason + ' 상세 화면에서 SRT를 직접 저장할 수 있습니다.', code };
}

/** Save only a complete, aligned Korean subtitle beside the local source video.
 * The analysis owner calls this on the selecting/client PC, never the LAN host.
 * Existing files are never replaced. An exclusive hard link publishes a synced
 * temporary file atomically where supported. FAT/exFAT and some network shares
 * need an exclusive copy instead; this may briefly expose an incomplete file,
 * but still never replaces a user's existing subtitle.
 */
async function saveKoreanSubtitle(record, { signal, io = fs } = {}) {
  if (signal?.aborted || !record || !['completed', 'partial'].includes(record.status)
    || record.subtitleLanguage !== 'ko' || record.subtitleError) return null;
  let text;
  try { text = subtitleText(record, { format: 'srt', language: 'ko' }); } catch (_) { return null; }
  const bytes = Buffer.from(text, 'utf8');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let temporary = '', target = '', published = '', temporaryStat, publishedStat;
  try {
    const source = await verifySource(io, record.path);
    if (signal?.aborted) return null;
    const basename = path.basename(source.path, path.extname(source.path));
    const suffix = typeof record.id === 'string' && /^[a-f0-9]{16,64}$/i.test(record.id)
      ? record.id.slice(0, 12).toLowerCase() : crypto.createHash('sha256').update(source.path).update(bytes).digest('hex').slice(0, 12);
    const candidates = Array.from({ length: MAX_CANDIDATES }, (_, index) => path.join(source.parent,
      index === 0 ? basename + '.ko.srt' : basename + '.videorandom-' + suffix + (index === 1 ? '' : '-' + index) + '.ko.srt'));
    for (const candidate of candidates) {
      target = candidate;
      if (signal?.aborted) return null;
      await verifySource(io, source.path, source);
      if (await identicalFile(io, candidate, bytes)) return signal?.aborted ? null : { status: 'unchanged', path: candidate, sha256 };
      // Create the temporary file lazily, since an identical existing SRT needs
      // no write permission. Only this owned, random file is ever cleaned up.
      if (!temporary) {
        const temporaryPath = path.join(source.parent, '.videorandom-subtitle-' + crypto.randomBytes(16).toString('hex') + '.tmp');
        const handle = await io.open(temporaryPath, 'wx', 0o600);
        temporary = temporaryPath;
        try { await handle.writeFile(bytes); await handle.sync(); temporaryStat = await handle.stat(); }
        finally { await handle.close(); }
      }
      if (signal?.aborted) return null;
      await verifySource(io, source.path, source);
      const ownedTemporary = await io.lstat(temporary);
      if (!ownedTemporary.isFile() || ownedTemporary.isSymbolicLink() || ownedTemporary.dev !== temporaryStat.dev || ownedTemporary.ino !== temporaryStat.ino) throw unsafePath();
      try {
        try {
          await io.link(temporary, candidate);
          publishedStat = temporaryStat;
        } catch (error) {
          if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
          // COPYFILE_EXCL preserves concurrent/user files. Native copyFile also
          // removes a destination it opened if copying fails; never blindly
          // unlink a failed destination, which may belong to someone else.
          await io.copyFile(temporary, candidate, COPYFILE_EXCL);
          publishedStat = await io.lstat(candidate);
        }
        published = candidate;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Another analysis/process may have published this exact content since
        // our first read. Reuse it instead of producing a duplicate file.
        if (await identicalFile(io, candidate, bytes)) return signal?.aborted ? null : { status: 'unchanged', path: candidate, sha256 };
        continue;
      }
      if (signal?.aborted) {
        const own = await io.lstat(published);
        if (own.dev === publishedStat.dev && own.ino === publishedStat.ino) await io.unlink(published);
        published = '';
        return null;
      }
      return { status: 'saved', path: candidate, sha256 };
    }
    const error = new Error('All subtitle names are occupied');
    error.code = 'NAME_CONFLICT';
    throw error;
  } catch (error) {
    return signal?.aborted ? null : failed(error, target);
  } finally {
    if (temporary) await io.unlink(temporary).catch(() => {});
  }
}

module.exports = { saveKoreanSubtitle };
