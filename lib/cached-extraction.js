const fs = require('fs').promises;
const path = require('path');
const { normalizeLanguageHint, detectedLanguage } = require('./subtitle-utils');
const { normalizeSubtitleQuality, isCurrentFullTranscription, normalizeTranscriptionQuality, sanitizeRichSegments } = require('./subtitle-quality');

const SAFE_ID = /^[a-f0-9]{16,64}$/;
const SAFE_FRAME = /^[a-zA-Z0-9_-]{1,90}\.jpe?g$/i;
const MAX_IMAGE = 5 * 1024 * 1024;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function fileKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
}

function sourceFileIdentity(value) {
  return value && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 && Number.isFinite(value.mtimeMs)
    ? { sizeBytes: value.sizeBytes, mtimeMs: value.mtimeMs } : null;
}

async function directoryInside(parent, target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('저장된 장면 폴더가 올바르지 않습니다.');
  const real = await fs.realpath(target);
  if (!inside(parent, real)) throw new Error('저장된 장면 경로가 저장 폴더를 벗어났습니다.');
  return real;
}

async function readJpeg(root, target) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 5 || stat.size > MAX_IMAGE) throw new Error('저장된 장면 파일이 올바르지 않습니다.');
  const real = await fs.realpath(target);
  if (!inside(root, real)) throw new Error('저장된 장면 경로가 올바르지 않습니다.');
  const handle = await fs.open(real, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('저장된 장면 파일이 변경되었습니다.');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const latest = await fs.lstat(target);
    const realAfter = await fs.realpath(target);
    if (count !== opened.size || latest.isSymbolicLink() || latest.ino !== opened.ino || latest.dev !== opened.dev || latest.size !== opened.size
      || !inside(root, realAfter) || fileKey(realAfter) !== fileKey(real)) throw new Error('저장된 장면 파일이 변경되었습니다.');
    const data = bytes.subarray(0, count);
    if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff || data[count - 2] !== 0xff || data[count - 1] !== 0xd9) throw new Error('저장된 JPEG 장면을 확인할 수 없습니다.');
    return data;
  } finally { await handle.close(); }
}

function eligibleRecord(file, options) {
  const saved = options.repairRecord;
  if (!['codex', 'remote'].includes(options.mode) || options.transcribeAudio === true || options.force === true || !saved || typeof saved !== 'object'
    || !SAFE_ID.test(saved.id) || !SAFE_ID.test(file?.id) || saved.id === file.id
    || typeof saved.path !== 'string' || typeof file.path !== 'string' || fileKey(saved.path) !== fileKey(file.path)
    || !Number.isFinite(saved.duration) || saved.duration <= 0 || saved.duration > 7 * 86400
    || !Array.isArray(saved.frames) || saved.frames.length !== (options.frameCount === undefined ? 10 : options.frameCount)
    || !saved.frames.length || saved.frames.length > 20 || typeof saved.transcriptSource !== 'string' || saved.transcriptSource === 'none'
    || !saved.transcriptSource.trim() || /partial/i.test(saved.transcriptSource)
    || !Array.isArray(saved.transcript) || !saved.transcript.length || saved.transcript.length > 50000) return null;
  const hint = normalizeLanguageHint(options.transcriptLanguage);
  const language = detectedLanguage(saved.transcriptLanguage);
  if (hint !== 'auto' && hint !== language) return null;
  if (normalizeSubtitleQuality(options.subtitleQuality) === 'accurate' && options.subtitleLanguage === 'ko'
      && !isCurrentFullTranscription(saved, 'accurate')) return null;
  let textBytes = 0, previousStart = -1;
  for (const cue of saved.transcript) {
    if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < previousStart || cue.start < 0
      || cue.end <= cue.start || cue.end > saved.duration + 60 || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 10000) return null;
    previousStart = cue.start;
    textBytes += Buffer.byteLength(cue.text);
    if (textBytes > 4 * 1024 * 1024) return null;
  }
  const names = new Set();
  for (const frame of saved.frames) {
    if (!frame || typeof frame.filename !== 'string' || !SAFE_FRAME.test(frame.filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(frame.filename)
      || names.has(frame.filename.toLowerCase()) || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > saved.duration + 1) return null;
    names.add(frame.filename.toLowerCase());
  }
  return saved;
}

async function reuseCachedExtraction(file, options, context) {
  const saved = eligibleRecord(file, options);
  if (!saved) return null;
  const sourceFile = sourceFileIdentity(saved.sourceFile);
  if (sourceFile && normalizeSubtitleQuality(options.subtitleQuality) === 'accurate' && options.subtitleLanguage === 'ko') {
    // Missing/offline originals must not invalidate already retained dialogue.
    // A visible replacement at the same path must be decoded again instead.
    const current = await fs.stat(file.path).catch(() => null);
    if (current && (!current.isFile() || current.size !== sourceFile.sizeBytes || current.mtimeMs !== sourceFile.mtimeMs)) return null;
  }
  let destination, frameRoot, createdDestination = false;
  const written = [];
  try {
    checkAbort(context.signal);
    const dataRoot = await fs.realpath(path.resolve(context.dataDir));
    frameRoot = await directoryInside(dataRoot, path.join(dataRoot, 'frames'));
    const sourceRoot = await directoryInside(frameRoot, path.join(frameRoot, saved.id));
    const images = [];
    for (const frame of saved.frames) {
      checkAbort(context.signal);
      images.push(await readJpeg(sourceRoot, path.join(sourceRoot, frame.filename)));
    }
    checkAbort(context.signal);
    destination = path.join(frameRoot, file.id);
    await fs.mkdir(destination);
    createdDestination = true;
    await directoryInside(frameRoot, destination);
    for (let index = 0; index < saved.frames.length; index++) {
      checkAbort(context.signal);
      await directoryInside(dataRoot, frameRoot);
      await directoryInside(frameRoot, destination);
      const filename = saved.frames[index].filename;
      await fs.writeFile(path.join(destination, filename), images[index], { flag: 'wx' });
      written.push(filename);
    }
    const extractionWarnings = (Array.isArray(saved.warnings) ? saved.warnings : []).filter(warning => typeof warning === 'string'
      && warning !== saved.error && warning !== saved.subtitleError && !/Codex.*(?:요약|실패)|한국어 자막|분석 서버.*(?:실패|업데이트)|재분석이 완료되지/.test(warning));
    context.onProgress?.('저장된 장면과 대사 재사용', 34);
    return { id: file.id, name: file.name || path.basename(file.path), path: path.resolve(file.path), ext: file.ext || path.extname(file.path).slice(1).toUpperCase(),
      size: Number(file.size) || Number(saved.size) || 0, duration: saved.duration, hasAudio: saved.hasAudio !== false,
      status: 'completed', summary: '', plot: '', dialogueSummary: '', labels: [], error: null,
      transcriptSource: saved.transcriptSource, transcriptLanguage: detectedLanguage(saved.transcriptLanguage),
      transcript: sanitizeRichSegments(saved.transcript),
      ...(saved.transcriptionQuality ? { transcriptionQuality: normalizeTranscriptionQuality(saved.transcriptionQuality) } : {}),
      ...(sourceFile ? { sourceFile } : {}),
      frames: saved.frames.map(frame => ({ timestamp: frame.timestamp, filename: frame.filename, caption: '' })),
      warnings: [...extractionWarnings, '저장된 대표 장면과 시간별 대사를 재사용해 요약과 자막을 다시 분석했습니다.'],
      analyzedAt: new Date().toISOString(), extractionReusedFrom: saved.id };
  } catch (error) {
    // Remove only files written to this fresh attempt; never touch the source.
    if (createdDestination && destination && frameRoot) {
      try {
        await directoryInside(frameRoot, destination);
        for (const filename of written) {
          const target = path.join(destination, filename);
          const real = await fs.realpath(target);
          if (inside(destination, real)) await fs.unlink(target);
        }
        await fs.rmdir(destination);
      } catch (_) { /* Re-extraction can safely overwrite remaining own files. */ }
    }
    if (error.name === 'AbortError') throw error;
    return null;
  }
}

module.exports = { reuseCachedExtraction, eligibleRecord };
