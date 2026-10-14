const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const extraction = require('./video-analysis');
const provider = require('./no-key-provider');

async function analyzeVideo(file, options, context) {
  // All media decoding is local. The legacy API provider is never selected.
  const extractionContext = options.mode === 'local' ? context : {
    ...context, onProgress(stage, percent) {
      if (stage !== 'completed') context.onProgress?.(stage, percent);
    }
  };
  const record = await extraction.analyzeVideo(file, { ...options, mode: 'local', apiKey: '' }, extractionContext);
  if (options.mode === 'local' || record.status === 'failed') return record;
  let audioPath;
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
    // The local-extraction-only notice no longer applies to an AI analysis.
    record.warnings = record.warnings.filter(warning => !warning.startsWith('읽을 수 있는 자막이 없습니다.'));
    const tools = await extraction.getToolsStatus(context.dataDir);
    if (options.mode === 'codex') {
      return await provider.analyzeExtracted(record, {
        dataDir: context.dataDir, signal: context.signal, onProgress: context.onProgress,
        transcribeAudio: options.transcribeAudio, videoPath: file.path, ffmpegPath: tools.ffmpeg.path
      });
    }
    if (options.mode !== 'remote') throw new Error('지원하지 않는 분석 방식입니다.');
    const { sendRemoteAnalysis, checkRemoteServer } = require('./lan-analysis');
    const connection = { remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, signal: context.signal };
    await checkRemoteServer(connection);
    if (record.hasAudio && (options.transcribeAudio || !record.transcript.length)) {
      context.onProgress?.('서버에 보낼 음성 준비', 35);
      const folder = path.join(context.dataDir, 'tmp');
      await fs.mkdir(folder, { recursive: true });
      audioPath = path.join(folder, `${record.id}-${crypto.randomBytes(8).toString('hex')}.mp3`);
      await extraction.runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-i', file.path,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', audioPath],
      { signal: context.signal, timeout: 60 * 60 * 1000 });
    }
    return await sendRemoteAnalysis(record, {
      ...connection, audioPath, dataDir: context.dataDir,
      transcribeAudio: options.transcribeAudio, onProgress: context.onProgress
    });
  } catch (error) {
    const partial = error.record || record;
    partial.status = partial.frames.length || partial.transcript.length ? 'partial' : 'failed';
    partial.error = error.message;
    partial.warnings = [...new Set([...(partial.warnings || []), error.message])];
    if (error.name === 'AbortError') { error.record = partial; throw error; }
    return partial;
  } finally {
    if (audioPath) await fs.rm(audioPath, { force: true }).catch(() => {});
  }
}

module.exports = { analyzeVideo, getToolsStatus: extraction.getToolsStatus, getProviderStatus: provider.getProviderStatus };
