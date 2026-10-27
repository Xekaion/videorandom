const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const extraction = require('./video-analysis');
const provider = require('./no-key-provider');
const { reuseCachedExtraction } = require('./cached-extraction');
const { normalizeSubtitleQuality, isCurrentFullTranscription, isProcessedTranscription } = require('./subtitle-quality');
const { classifyAnalysisFailure, sanitizeDiagnosticEvent } = require('./diagnostics');
const { estimateAnalysisDiskBytes } = require('./disk-space');
const PREFLIGHT_NETWORK_ERRORS = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN']);

function clearTransportProof(record) {
  if (record && typeof record === 'object') delete record.analysisTransport;
  return record;
}

function preflightTransportProof(error, diagnostic) {
  const proof = error?.analysisTransport;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== 3
    || proof.version !== 1 || proof.phase !== 'preflight' || proof.submission !== 'not-submitted'
    || !PREFLIGHT_NETWORK_ERRORS.has(error.code) || !['NETWORK_UNREACHABLE', 'PROVIDER_TIMEOUT'].includes(diagnostic.code)
    || error.name === 'AbortError' || error.remoteJob || error.cause || error.causeCode || error.diagnostic
    || error.providerErrorType || error.executionSource || error.refusalSource
    || [error.statusCode, error.httpStatus].some(status => Number.isInteger(status) && status >= 400)
    || Object.keys(error).some(key => /^(?:provider|execution|refusal)/.test(key))) return null;
  return { version: 1, phase: 'preflight', submission: 'not-submitted' };
}

function createCatalogEngine({ extractionImpl = extraction, providerImpl = provider, lanImpl } = {}) {
function retainFailure(record, error, stage, diagnosticField = 'analysisDiagnostic') {
  if (!error || typeof error !== 'object') error = new Error(typeof error === 'string' ? error : '분석 작업을 완료하지 못했습니다.');
  const partial = error.record && typeof error.record === 'object' && !Array.isArray(error.record) ? error.record : record;
  if (record.extractionReusedFrom) partial.extractionReusedFrom = record.extractionReusedFrom;
  partial.status = partial.frames?.length || partial.transcript?.length ? 'partial' : 'failed';
  partial.error = error.message;
  partial.warnings = [...new Set([...(Array.isArray(partial.warnings) ? partial.warnings : []), error.message])];
  const diagnostic = sanitizeDiagnosticEvent(error.diagnostic);
  partial[diagnosticField] = { ...diagnostic, ...classifyAnalysisFailure(error),
    event: 'error', level: 'error', stage: diagnostic.stage || stage };
  delete partial.analysisTransport;
  const transport = preflightTransportProof(error, partial[diagnosticField]);
  if (transport) partial.analysisTransport = transport;
  delete partial.remoteJobRecovery;
  if (error.remoteJob && typeof error.remoteJob === 'object' && !Array.isArray(error.remoteJob)) {
    partial.remoteJobRecovery = { recoverable: error.remoteJobRecoverable === true, receipt: error.remoteJob };
  }
  delete partial.storageWait;
  if (error.code === 'STORAGE_SPACE_LOW') {
    partial.storageWait = { location: error.storageLocation === 'remote' ? 'remote' : 'local' };
    for (const key of ['availableBytes', 'requiredBytes', 'reserveBytes']) {
      if (Number.isSafeInteger(error[key]) && error[key] >= 0) partial.storageWait[key] = error[key];
    }
  }
  if (error.name === 'AbortError') { error.record = partial; throw error; }
  return partial;
}
async function analyzeVideo(file, options, context) {
  const turboRequested = normalizeSubtitleQuality(options.subtitleQuality) === 'turbo';
  const accurateRequested = normalizeSubtitleQuality(options.subtitleQuality) === 'accurate';
  const accurateKorean = accurateRequested && options.subtitleLanguage === 'ko';
  const freshSpeech = options.mode !== 'local' && options.transcribeAudio === true;
  let remotePreflightHost, audioPath, preparedAudio, preparedTools, audioController, forwardAudioAbort;
  // A newly probed accurate Korean analysis must recognize the complete audio:
  // fresh extraction has no current full-ASR proof. Start its one lossless
  // encode alongside the extractor's two frame seeks, after the same guards.
  // Cache reuse, other profiles and extractors without this private hook retain
  // their original audio-need decisions and serial preparation path.
  const prepareProbedAudio = async (metadata, binaries) => {
    if (preparedAudio || !accurateKorean || !['codex', 'remote'].includes(options.mode) || metadata.hasAudio !== true
      || options.mode === 'codex' && typeof providerImpl.getProviderStatus !== 'function') return;
    let stage = 'processing';
    try {
      if (context.signal?.aborted) throw Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
      if (typeof context.diskSpace?.assert === 'function') await context.diskSpace.assert({ path: context.dataDir,
        requiredBytes: estimateAnalysisDiskBytes({ durationSeconds: metadata.duration, frameCount: options.frameCount || 10,
          audioExists: false, translationOnly: false }) });
      if (options.mode === 'codex') {
        stage = 'summary';
        const status = await providerImpl.getProviderStatus(context.dataDir);
        if (!status.codex?.available || !status.codex?.loggedIn) throw new Error(status.codex?.error || 'Codex의 ChatGPT 로그인이 필요합니다.');
        if (!status.speech?.available) throw new Error(status.speech?.error || '로컬 음성 인식 환경을 설치해야 합니다.');
      } else {
        stage = 'connection';
        const { checkRemoteServer } = lanImpl || require('./lan-analysis');
        remotePreflightHost = await checkRemoteServer({ remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, signal: context.signal });
        if (!remotePreflightHost.capabilities?.includes('subtitle-quality-v3')) {
          throw new Error('긴 영상 재검수를 적용한 정확도 우선 자막을 사용하려면 분석 서버 PC도 1.6.6 이상으로 업데이트해 주세요. 이전 서버에서는 빠른 분석을 사용할 수 있습니다.');
        }
      }
      stage = 'audio';
      if (context.signal?.aborted) throw Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
      const folder = path.join(context.dataDir, 'tmp');
      await fs.mkdir(folder, { recursive: true });
      audioPath = path.join(folder, `${metadata.id}-${crypto.randomBytes(8).toString('hex')}.flac`);
      audioController = new AbortController();
      forwardAudioAbort = () => audioController.abort(context.signal.reason);
      context.signal?.addEventListener('abort', forwardAudioAbort, { once: true });
      if (context.signal?.aborted) forwardAudioAbort();
      preparedTools = { available: true, ffmpeg: { path: binaries.ffmpeg }, ffprobe: { path: binaries.ffprobe } };
      const encoding = options.mode === 'codex' ? ['-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '0']
        : ['-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '0'];
      // Capture rejection immediately. The owning call always drains this
      // outcome before returning, including extraction failure and abort.
      preparedAudio = Promise.resolve().then(() => extractionImpl.runProcess(binaries.ffmpeg,
        ['-nostdin', '-v', 'error', '-y', '-i', file.path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', ...encoding, audioPath],
        { signal: audioController.signal, timeout: 60 * 60 * 1000 })).then(() => ({}), error => ({ error, stage }));
    } catch (error) {
      // Frames still finish as before, so a connection/environment failure does
      // not discard useful images or lose the original typed failure evidence.
      preparedAudio = Promise.resolve({ error, stage });
    }
  };
  try {
  if (options.mode === 'remote' && turboRequested) {
    const { checkRemoteServer } = lanImpl || require('./lan-analysis');
    remotePreflightHost = await checkRemoteServer({ remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, signal: context.signal });
    if (!remotePreflightHost.capabilities?.includes('turbo-subtitles-v1')) {
      throw new Error('초고속 분석을 사용하려면 분석 서버 PC도 최신 버전으로 업데이트해 주세요.');
    }
  }
  // All media decoding is local. The legacy API provider is never selected.
  const extractionContext = options.mode === 'local' ? context : {
    ...context, onProbed: prepareProbedAudio, onProgress(stage, percent) {
      if (stage !== 'completed') context.onProgress?.(stage, percent);
    }
  };
  const { repairRecord, skipExistingSubtitles, ...extractionOptions } = options;
  const record = await reuseCachedExtraction(file, options, context)
    || await extractionImpl.analyzeVideo(file, { ...extractionOptions, mode: 'local', apiKey: '', skipExistingSubtitles: freshSpeech }, extractionContext);
  if (freshSpeech) {
    // Explicit speech recognition starts from the source audio. Existing user
    // subtitles and an earlier ASR result cannot become a fallback presented as
    // this new attempt; the earlier durable record remains owned by the service.
    record.transcript = [];
    record.transcriptSource = 'none';
    delete record.transcriptLanguage;
    delete record.transcriptionQuality;
    delete record.extractionReusedFrom;
  }
  clearTransportProof(record);
  if (options.mode === 'local') return record;
  if (record.status === 'failed') audioController?.abort();
  if (preparedAudio) {
    if (audioPath && record.status !== 'failed') context.onProgress?.(options.mode === 'remote' ? '서버에 보낼 음성 준비' : 'transcription', options.mode === 'remote' ? 35 : 34);
    const outcome = await preparedAudio;
    if (outcome.error && !(record.status === 'failed' && outcome.error.name === 'AbortError' && !context.signal?.aborted)) {
      return retainFailure(record, outcome.error, outcome.stage);
    }
  }
  if (record.status === 'failed') return record;
  let failureStage = 'processing';
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('분석이 중지되었습니다.'), { name: 'AbortError' });
    if (typeof context.diskSpace?.assert === 'function') {
      await context.diskSpace.assert({ path: context.dataDir,
        requiredBytes: estimateAnalysisDiskBytes({ durationSeconds: record.duration, frameCount: record.frames?.length || 10,
          audioExists: Boolean(audioPath), translationOnly: false }) });
    }
    // The local-extraction-only notice no longer applies to an AI analysis.
    record.warnings = record.warnings.filter(warning => !warning.startsWith('읽을 수 있는 자막이 없습니다.'));
    const needsFullAudio = accurateKorean && !isCurrentFullTranscription(record, 'accurate')
      || turboRequested && (!isProcessedTranscription(record, 'turbo') || record.transcriptionQuality?.complete !== true);
    const needsAudio = record.hasAudio && (options.transcribeAudio || !record.transcript.length || needsFullAudio);
    const tools = needsAudio ? preparedTools || await extractionImpl.getToolsStatus(context.dataDir) : null;
    if (options.mode === 'codex') {
      failureStage = 'summary';
      return clearTransportProof(await providerImpl.analyzeExtracted(record, {
        dataDir: context.dataDir, signal: context.signal, onProgress: context.onProgress, onDiagnostic: context.onDiagnostic,
        transcribeAudio: options.transcribeAudio, videoPath: file.path, ffmpegPath: tools?.ffmpeg?.path,
        ...(audioPath ? { audioPath } : {}),
        transcriptLanguage: options.transcriptLanguage, subtitleLanguage: options.subtitleLanguage, subtitleQuality: options.subtitleQuality
      }));
    }
    if (options.mode !== 'remote') throw new Error('지원하지 않는 분석 방식입니다.');
    const { sendRemoteAnalysis, checkRemoteServer } = lanImpl || require('./lan-analysis');
    const connection = { remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, signal: context.signal };
    failureStage = 'connection';
    const host = remotePreflightHost || await checkRemoteServer(connection);
    if (turboRequested && !host.capabilities?.includes('turbo-subtitles-v1')) {
      throw new Error('초고속 분석을 사용하려면 분석 서버 PC도 최신 버전으로 업데이트해 주세요.');
    }
    if (accurateRequested && !host.capabilities?.includes('subtitle-quality-v3')) {
      throw new Error('긴 영상 재검수를 적용한 정확도 우선 자막을 사용하려면 분석 서버 PC도 1.6.6 이상으로 업데이트해 주세요. 이전 서버에서는 빠른 분석을 사용할 수 있습니다.');
    }
    if (needsAudio && !audioPath) {
      failureStage = 'audio';
      context.onProgress?.('서버에 보낼 음성 준비', 35);
      const folder = path.join(context.dataDir, 'tmp');
      await fs.mkdir(folder, { recursive: true });
      const losslessRequested = accurateKorean || turboRequested;
      audioPath = path.join(folder, `${record.id}-${crypto.randomBytes(8).toString('hex')}.${losslessRequested ? 'flac' : 'mp3'}`);
      await extractionImpl.runProcess(tools.ffmpeg.path, ['-nostdin', '-v', 'error', '-y', '-i', file.path,
        // FLAC level zero avoids extra compression work while retaining the
        // exact same 16-bit PCM for accurate and turbo recognition.
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', ...(losslessRequested ? ['-c:a', 'flac', '-sample_fmt', 's16',
          '-compression_level', '0'] : ['-c:a', 'libmp3lame', '-b:a', '48k']), audioPath],
      { signal: context.signal, timeout: 60 * 60 * 1000 });
    }
    failureStage = 'processing';
    const analyzed = await sendRemoteAnalysis(record, {
      ...connection, audioPath, dataDir: context.dataDir,
      transcribeAudio: options.transcribeAudio, onProgress: context.onProgress, onDiagnostic: context.onDiagnostic,
      diagnosticClient: context.diagnosticClient,
      onRemoteJobAccepted: context.onRemoteJobAccepted,
      transcriptLanguage: options.transcriptLanguage, subtitleLanguage: options.subtitleLanguage, subtitleQuality: options.subtitleQuality
    });
    if (record.extractionReusedFrom) analyzed.extractionReusedFrom = record.extractionReusedFrom;
    return clearTransportProof(analyzed);
  } catch (error) {
    return retainFailure(record, error, failureStage);
  }
  } finally {
    // Only this call's encode is cancelled. Drain it before deleting its own
    // file, even when extraction threw before a provider could take ownership.
    audioController?.abort();
    if (preparedAudio) await preparedAudio;
    if (forwardAudioAbort) context.signal?.removeEventListener('abort', forwardAudioAbort);
    if (audioPath) await fs.rm(audioPath, { force: true }).catch(() => {});
  }
}

async function resumeRemoteAnalysis(record, options, receipt, context) {
  clearTransportProof(record);
  const { resumeRemoteAnalysis: resume } = lanImpl || require('./lan-analysis');
  try {
    return clearTransportProof(await resume(record, {
      remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, dataDir: context.dataDir,
      signal: context.signal, onProgress: context.onProgress, onDiagnostic: context.onDiagnostic,
      operation: options.operation || receipt?.operation
    }, receipt));
  } catch (error) {
    delete error.analysisTransport;
    return retainFailure(record, error, 'connection', (options.operation || receipt?.operation) === 'translation-only' ? 'subtitleDiagnostic' : 'analysisDiagnostic');
  }
}

async function getRemoteStatus(options) {
  const { checkRemoteServer } = lanImpl || require('./lan-analysis');
  return checkRemoteServer({ remoteUrl: options.remoteUrl, connectionCode: options.connectionCode, signal: options.signal });
}

async function translateSubtitles(record, options, context) {
  clearTransportProof(record);
  if (options.mode === 'codex') return clearTransportProof(await providerImpl.translateKoreanOnly(record, {
    dataDir: context.dataDir, signal: context.signal, onProgress: context.onProgress, onDiagnostic: context.onDiagnostic,
    subtitleQuality: options.subtitleQuality, forceTranslation: options.forceTranslation
  }));
  if (options.mode === 'remote') {
    const { sendRemoteAnalysis } = lanImpl || require('./lan-analysis');
    return clearTransportProof(await sendRemoteAnalysis(record, {
      dataDir: context.dataDir, signal: context.signal, onProgress: context.onProgress, onDiagnostic: context.onDiagnostic,
      diagnosticClient: context.diagnosticClient,
      onRemoteJobAccepted: context.onRemoteJobAccepted,
      remoteUrl: options.remoteUrl, connectionCode: options.connectionCode,
      transcriptLanguage: ['ja', 'zh'].includes(record.transcriptLanguage) ? record.transcriptLanguage : 'auto',
      subtitleLanguage: 'ko', subtitleQuality: options.subtitleQuality,
      operation: 'translation-only', forceTranslation: options.forceTranslation
    }));
  }
  throw new Error('한국어 자막 번역에는 이 PC의 Codex 또는 분석 서버 연결을 선택해 주세요.');
}

return { analyzeVideo, translateSubtitles, resumeRemoteAnalysis, getRemoteStatus, getToolsStatus: extractionImpl.getToolsStatus, getProviderStatus: providerImpl.getProviderStatus };
}

module.exports = { ...createCatalogEngine(), createCatalogEngine };
