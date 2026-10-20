const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { Transform, pipeline } = require('stream');
const { normalizeLanguageHint, normalizeSubtitleLanguage, detectedLanguage, validateTranslation, validatePartialTranslation } = require('./subtitle-utils');
const { normalizeSubtitleQuality, isCurrentFullTranscription, isProcessedTranscription, normalizeTranscriptionQuality, sanitizeRichSegments } = require('./subtitle-quality');
const { normalizeProgressDetails, ageProgressDetails } = require('../public/js/analysis-progress');
const { sanitizeAnalysisProvenance, stampAnalysisProvenance, attachRemoteServerVersion } = require('./analysis-provenance');
const { createDiagnosticsStore, sanitizeDiagnosticEvent, classifyDiagnosticError } = require('./diagnostics');
const { stageIdentity } = require('./job-metrics');
const { processedSubtitleGaps } = require('./subtitle-processing');
const APP_VERSION = require('../package.json').version;

const MB = 1024 * 1024;
const MAX_IMAGE = 5 * MB;
const MAX_AUDIO = 250 * MB;
const LEGACY_MAX_METADATA = 2 * MB;
const MAX_METADATA = 8 * MB;
const MAX_SUBTITLE_CONTENT = 4 * MB;
const MAX_UPLOAD = MAX_AUDIO + 20 * MAX_IMAGE + MAX_METADATA + MB;
const SAFE_FRAME = /^[a-zA-Z0-9_-]{1,90}\.jpe?g$/i;
const SAFE_ID = /^[a-f0-9]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATUS_RECONNECT_DELAYS = [250, 500, 1000];
const UPDATE_RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 14000];
const TRANSIENT_NETWORK_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN']);

function safeFrameFilename(value) {
  return typeof value === 'string' && SAFE_FRAME.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(value);
}

function frameFingerprints(value, frames) {
  // An optional optimization must never let response metadata select a path.
  // Each key must already belong to this job's validated original image list.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const names = new Set(frames.map(frame => frame.filename));
  const entries = Object.entries(value);
  if (entries.length > names.size || entries.some(([name, digest]) => !names.has(name)
    || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) return null;
  return Object.fromEntries(entries);
}

async function localFrameFingerprint(filename, signal) {
  if (signal?.aborted) throw abortError();
  let bytes, handle;
  try {
    const stat = await fsp.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 3 || stat.size > MAX_IMAGE) return null;
    handle = await fsp.open(filename, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) return null;
    // Read at most the checked image size plus one byte, even if another
    // process grows/replaces the image between stat and read.
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      if (signal?.aborted) throw abortError();
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const latest = await fsp.lstat(filename);
    if (size !== opened.size || !latest.isFile() || latest.isSymbolicLink() || latest.ino !== opened.ino || latest.dev !== opened.dev
      || latest.size !== opened.size || latest.mtimeMs !== opened.mtimeMs || latest.ctimeMs !== opened.ctimeMs) return null;
    bytes = buffer.subarray(0, size);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    return null;
  } finally { if (handle) await handle.close().catch(() => {}); }
  if (signal?.aborted) throw abortError();
  if (bytes.length < 3 || bytes.length > MAX_IMAGE || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function privateAddress(input) {
  let address = String(input || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (net.isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  }
  if (net.isIP(address) === 6) return address === '::1' || ((parseInt(address.split(':')[0], 16) & 0xfe00) === 0xfc00);
  return false;
}

function abortError() {
  const error = new Error('분석을 중지했습니다.');
  error.name = 'AbortError';
  return error;
}

function textValue(value, limit, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000')) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return value;
}

function transportQuality(value) {
  const quality = normalizeTranscriptionQuality(value);
  // A local model directory is not transport metadata. Its basename still
  // identifies the selected model and any explicit environment override.
  if (quality && /^(?:[a-z]:[\\/]|[\\/])/i.test(quality.model)) quality.model = quality.model.split(/[\\/]/).filter(Boolean).pop();
  return quality;
}

function validateMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('영상 정보가 올바르지 않습니다.');
  const allowed = new Set(['name', 'ext', 'sizeMB', 'duration', 'transcript', 'transcriptSource', 'frames', 'transcribeAudio', 'hasAudio', 'transcriptLanguage', 'subtitleLanguage', 'subtitleQuality', 'transcriptionQuality', 'operation', 'forceTranslation', 'diagnosticClient']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('지원하지 않는 영상 정보가 포함되어 있습니다.');
  const translationOnly = input.operation === 'translation-only';
  if (input.operation !== undefined && !translationOnly) throw new Error('지원하지 않는 분석 작업입니다.');
  if (input.forceTranslation !== undefined && (!translationOnly || typeof input.forceTranslation !== 'boolean')) throw new Error('번역 복구 설정이 올바르지 않습니다.');
  const name = textValue(input.name, 255, '파일명');
  if (!name || /[\\/\x00-\x1f]/.test(name)) throw new Error('파일명이 올바르지 않습니다.');
  const ext = textValue(input.ext, 16, '확장자');
  if (!/^[a-zA-Z0-9]{1,16}$/.test(ext)) throw new Error('확장자가 올바르지 않습니다.');
  if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 7 * 86400) throw new Error('영상 길이가 올바르지 않습니다.');
  if (input.sizeMB !== undefined && (typeof input.sizeMB !== 'number' || !Number.isFinite(input.sizeMB) || input.sizeMB < 0)) throw new Error('영상 크기가 올바르지 않습니다.');
  if (input.transcribeAudio !== undefined && typeof input.transcribeAudio !== 'boolean') throw new Error('음성 인식 설정이 올바르지 않습니다.');
  if (input.hasAudio !== undefined && typeof input.hasAudio !== 'boolean') throw new Error('음성 정보가 올바르지 않습니다.');
  const transcriptLanguage = normalizeLanguageHint(input.transcriptLanguage);
  const subtitleLanguage = normalizeSubtitleLanguage(input.subtitleLanguage);
  const subtitleQuality = normalizeSubtitleQuality(input.subtitleQuality);
  if (!Array.isArray(input.frames) || (translationOnly ? input.frames.length !== 0 : input.frames.length < 1 || input.frames.length > 20)) throw new Error(translationOnly ? '번역 복구에는 대표 이미지를 전송할 수 없습니다.' : '대표 이미지는 1~20장 필요합니다.');
  if (translationOnly && (input.transcribeAudio === true || subtitleLanguage !== 'ko')) throw new Error('한국어 번역 복구에는 음성 인식 없이 저장된 원문만 사용해야 합니다.');
  const filenames = new Set();
  const frames = input.frames.map(frame => {
    if (!frame || typeof frame !== 'object' || !safeFrameFilename(frame.filename) || filenames.has(frame.filename.toLowerCase())
      || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || frame.timestamp > input.duration + 1
      || Object.keys(frame).some(key => !['timestamp', 'filename'].includes(key))) throw new Error('대표 이미지 정보가 올바르지 않습니다.');
    filenames.add(frame.filename.toLowerCase());
    return { filename: frame.filename, timestamp: frame.timestamp, caption: '' };
  });
  const source = input.transcript === undefined ? [] : input.transcript;
  if (!Array.isArray(source) || source.length > 50000) throw new Error('대사 기록이 너무 크거나 올바르지 않습니다.');
  const transcript = source.map(segment => {
    if (!segment || typeof segment !== 'object' || typeof segment.start !== 'number' || typeof segment.end !== 'number'
      || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > input.duration + 60
      || Object.keys(segment).some(key => !['id', 'start', 'end', 'text', 'words', 'avgLogprob', 'noSpeechProbability', 'confidence', 'qualityFlags'].includes(key))) throw new Error('대사 시간 정보가 올바르지 않습니다.');
    const normalized = sanitizeRichSegments([{ ...segment, text: textValue(segment.text, 10000, '대사') }]);
    if (normalized.length !== 1) throw new Error('대사 시간 정보가 올바르지 않습니다.');
    return normalized[0];
  });
  const transcriptionQuality = input.transcriptionQuality === undefined ? null : transportQuality(input.transcriptionQuality);
  if (input.transcriptionQuality !== undefined && !transcriptionQuality) throw new Error('음성 인식 품질 정보가 올바르지 않습니다.');
  if (translationOnly && !transcript.length) throw new Error('한국어 번역 복구에 사용할 저장된 원문 대사가 없습니다.');
  return { name, ext: ext.toUpperCase(), size: input.sizeMB || 0, duration: input.duration, transcript,
    transcriptSource: textValue(input.transcriptSource, 200, '대사 출처', 'none'), frames, transcribeAudio: input.transcribeAudio === true, hasAudio: input.hasAudio === true,
    transcriptLanguage, subtitleLanguage, subtitleQuality, ...(transcriptionQuality ? { transcriptionQuality } : {}),
    ...(translationOnly ? { operation: 'translation-only', forceTranslation: input.forceTranslation === true } : {}),
    ...(input.diagnosticClient === undefined ? {} : { diagnosticClient: validateDiagnosticClient(input.diagnosticClient) }) };
}

function validateDiagnosticClient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['clientId', 'clientName', 'clientVersion', 'clientJobId', 'recordId'].includes(key))) throw new Error('진단 PC 식별 정보가 올바르지 않습니다.');
  const clean = sanitizeDiagnosticEvent(value);
  if (!clean.clientId || Object.keys(value).some(key => value[key] !== clean[key])) throw new Error('진단 PC 식별 정보가 올바르지 않습니다.');
  return Object.fromEntries(['clientId', 'clientName', 'clientVersion', 'clientJobId', 'recordId'].filter(key => clean[key] !== undefined).map(key => [key, clean[key]]));
}

function translationPrefix(prefix, source, count, progress) {
  if (!Array.isArray(prefix) || prefix.length !== count) throw new Error('한국어 번역 진행 개수가 저장된 일부 자막과 일치하지 않습니다.');
  const sparse = progress?.version === 2;
  const indexes = sparse ? progress.cueIndexes : prefix.map((_, index) => index);
  if (sparse && (!Array.isArray(indexes) || indexes.length !== count || indexes.length > 50000
    || indexes.some((index, offset) => !Number.isSafeInteger(index) || index < 0 || index >= source.length || offset > 0 && index <= indexes[offset - 1]))) {
    throw new Error('일부 한국어 자막의 원문 번호가 올바르지 않습니다.');
  }
  return prefix.map((cue, index) => {
    const original = source[indexes[index]];
    if (!original || !cue || cue.start !== original.start || cue.end !== original.end || typeof cue.text !== 'string' || !cue.text.trim()
        || cue.text.length > 10000 || (sparse ? cue.id !== original.id : cue.id !== undefined && cue.id !== original.id)) throw new Error('일부 한국어 자막의 시간이나 번호가 원문과 일치하지 않습니다.');
    return { start: original.start, end: original.end, text: cue.text.trim(), ...(original.id === undefined ? {} : { id: original.id }) };
  });
}

function compactTranscriptDiagnostics(transcript, reservedBytes, budget) {
  const bytes = cues => Buffer.byteLength(JSON.stringify(cues)) + reservedBytes;
  if (bytes(transcript) <= budget) return { transcript, reduced: false };
  // Timed text is the result. Word probabilities and other diagnostics are
  // optional, so a long recording must not lose its final cues to keep them.
  const removedWords = transcript.some(cue => Object.prototype.hasOwnProperty.call(cue, 'words'));
  const withoutWords = transcript.map(({ words, ...cue }) => cue);
  if (bytes(withoutWords) <= budget) return { transcript: withoutWords, reduced: removedWords };
  const removedDiagnostics = transcript.some(cue => Object.keys(cue).some(key => !['id', 'start', 'end', 'text'].includes(key)));
  return { transcript: transcript.map(({ id, start, end, text }) => ({ start, end, text, ...(id === undefined ? {} : { id }) })), reduced: removedDiagnostics };
}

function translationContentBytes(record, source) {
  let bytes = 0;
  if (record.subtitleLanguage === 'ko' && Array.isArray(record.subtitleTranslation)) {
    try { bytes += Buffer.byteLength(JSON.stringify(validateTranslation(record.subtitleTranslation, source))); }
    catch (_) { /* Invalid translations do not reserve space from valid text. */ }
  }
  const progress = record.subtitleTranslationProgress;
  if (progress && Number.isSafeInteger(progress.completedCues) && progress.completedCues >= 0 && progress.completedCues <= source.length
      && Array.isArray(record.subtitleTranslationPartial)) {
    try {
      validatePartialTranslation({ ...record, transcript: source });
      bytes += Buffer.byteLength(JSON.stringify(translationPrefix(record.subtitleTranslationPartial, source, progress.completedCues, progress)));
      if (progress.version === 2) bytes += Buffer.byteLength(JSON.stringify(progress.cueIndexes));
    }
    catch (_) { /* The normal progress validation below reports the mismatch. */ }
  }
  return bytes;
}

// Never expose paths or provider credentials from the host in the transport result.
function publicRecord(record, original) {
  const result = {};
  for (const key of ['id', 'path', 'name', 'ext', 'size', 'duration', 'hasAudio', 'analyzedAt', 'summary', 'plot', 'dialogueSummary', 'status', 'transcriptSource']) {
    if (original[key] !== undefined) result[key] = original[key];
  }
  for (const key of ['summary', 'plot', 'dialogueSummary', 'status', 'analyzedAt', 'error', 'summaryError', 'transcriptSource']) {
    if (typeof record[key] === 'string') result[key] = record[key].slice(0, 100000);
  }
  result.labels = Array.isArray(record.labels) ? record.labels.filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 100)) : [];
  result.warnings = Array.isArray(record.warnings) ? record.warnings.filter(x => typeof x === 'string').slice(0, 100).map(x => x.slice(0, 2000)) : [];
  let transcriptBytes = 2;
  const sourceTranscript = Array.isArray(record.transcript) ? record.transcript : original.transcript || [];
  const sanitizedTranscript = sanitizeRichSegments(sourceTranscript);
  let incompleteTranscript = sanitizedTranscript.length !== sourceTranscript.length;
  if (sourceTranscript.length > 50000) result.warnings.push(`대사 기록 ${sourceTranscript.length.toLocaleString('en-US')}개가 50,000개 제한을 초과해 일부만 전달되었습니다.`);
  const compacted = compactTranscriptDiagnostics(sanitizedTranscript, translationContentBytes(record, sanitizedTranscript), MAX_SUBTITLE_CONTENT);
  if (compacted.reduced) result.warnings.push('원문과 한국어 자막의 내용과 시간을 우선 보관하기 위해 일부 단어별 진단 정보를 전송에서 제외했습니다.');
  let sizeTruncated = false, acceptedCues = 0;
  result.transcript = compacted.transcript.filter(s => {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end) || typeof s.text !== 'string') return false;
    const bytes = Buffer.byteLength(JSON.stringify(s)) + (acceptedCues ? 1 : 0);
    if (sizeTruncated || transcriptBytes + bytes > MAX_SUBTITLE_CONTENT) { sizeTruncated = true; return false; }
    transcriptBytes += bytes;
    acceptedCues++;
    return true;
  });
  if (sizeTruncated) {
    incompleteTranscript = true;
    result.warnings.push('대사 기록이 응답 크기 제한을 초과해 일부만 전달되었습니다.');
    result.status = 'partial';
  }
  if (incompleteTranscript) {
    result.status = 'partial';
    if (!sizeTruncated) result.warnings.push('대사 일부의 형식이나 개수 제한을 확인할 수 없어 전체 인식 완료로 표시하지 않았습니다.');
  }
  result.transcriptLanguage = detectedLanguage(record.transcriptLanguage) || detectedLanguage(original.transcriptLanguage);
  if (record.transcriptionQuality) {
    const quality = transportQuality(record.transcriptionQuality);
    if (quality) {
      result.transcriptionQuality = incompleteTranscript ? { ...quality, complete: false } : quality;
    }
  }
  if (typeof record.subtitleError === 'string') result.subtitleError = record.subtitleError.slice(0, 2000);
  for (const key of ['subtitleDiagnostic', 'analysisDiagnostic']) if (record[key] && typeof record[key] === 'object') result[key] = sanitizeDiagnosticEvent(record[key]);
  let payloadBytes = Buffer.byteLength(JSON.stringify(result.transcript));
  if (record.subtitleLanguage === 'ko' && Array.isArray(record.subtitleTranslation)) {
    try {
      const translation = validateTranslation(record.subtitleTranslation, result.transcript);
      const bytes = Buffer.byteLength(JSON.stringify(translation));
      if (payloadBytes + bytes > MAX_SUBTITLE_CONTENT) throw new Error('원문과 한국어 자막이 응답 크기 제한을 초과했습니다.');
      result.subtitleLanguage = 'ko';
      result.subtitleTranslation = translation;
      payloadBytes += bytes;
    } catch (error) {
      result.subtitleError = error.message;
      result.warnings.push('한국어 자막의 형식이나 시간 정보가 올바르지 않아 원문 대사만 보관했습니다.');
      result.status = 'partial';
    }
  }
  if (record.subtitleTranslationProgress !== undefined || record.subtitleTranslationPartial !== undefined) {
    try {
      const progress = record.subtitleTranslationProgress;
      const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(result.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex');
      if (!progress || ![1, 2].includes(progress.version) || progress.language !== 'ko' || typeof progress.sourceFingerprint !== 'string'
          || !/^[a-f0-9]{64}$/i.test(progress.sourceFingerprint) || progress.sourceFingerprint.toLowerCase() !== sourceFingerprint
          || !Number.isSafeInteger(progress.totalCues) || progress.totalCues < 1 || progress.totalCues !== result.transcript.length
          || !Number.isSafeInteger(progress.completedCues) || progress.completedCues < 0 || progress.completedCues > progress.totalCues
          || typeof progress.complete !== 'boolean' || typeof progress.sourceComplete !== 'boolean' || incompleteTranscript) {
        throw new Error('한국어 번역 진행 기록이 원문 대사와 일치하지 않습니다.');
      }
      const sourceComplete = progress.sourceComplete && result.transcriptionQuality?.complete !== false;
      if (progress.version === 2 && progress.complete !== false) throw new Error('빠진 구간이 있는 한국어 자막을 완성본으로 표시할 수 없습니다.');
      if (progress.complete && (!sourceComplete || progress.completedCues !== progress.totalCues || !result.subtitleTranslation)) {
        throw new Error('한국어 번역 완료 기록을 확인할 수 없습니다.');
      }
      const detail = {};
      for (const key of ['translationComplete', 'sourceProcessed', 'sourceAuditComplete']) {
        if (progress[key] !== undefined) {
          if (typeof progress[key] !== 'boolean') throw new Error('한국어 번역 진행 상태가 올바르지 않습니다.');
          detail[key] = progress[key];
        }
      }
      if (result.transcriptionQuality?.profile === 'turbo') detail.sourceAuditComplete = false;
      if (detail.translationComplete === true && progress.completedCues !== progress.totalCues
          || progress.complete && detail.translationComplete === false) throw new Error('한국어 번역 검수 완료 기록이 원문과 일치하지 않습니다.');
      let partial;
      if (!progress.complete || record.subtitleTranslationPartial !== undefined) {
        const prefix = record.subtitleTranslationPartial === undefined && progress.completedCues === 0 ? [] : record.subtitleTranslationPartial;
        partial = translationPrefix(prefix, result.transcript, progress.completedCues, progress);
        if (partial.length && (progress.version === 2 || !progress.complete)) validatePartialTranslation({ transcript: result.transcript, subtitleTranslationPartial: partial, subtitleTranslationProgress: progress });
        const mappingBytes = progress.version === 2 ? Buffer.byteLength(JSON.stringify(progress.cueIndexes)) : 0;
        if (payloadBytes + Buffer.byteLength(JSON.stringify(partial)) + mappingBytes > MAX_SUBTITLE_CONTENT) throw new Error('원문과 일부 한국어 자막이 응답 크기 제한을 초과했습니다.');
      }
      result.subtitleTranslationProgress = { version: progress.version, sourceFingerprint, totalCues: progress.totalCues, completedCues: progress.completedCues,
        language: 'ko', complete: progress.complete && sourceComplete, sourceComplete, ...detail,
        ...(progress.version === 2 ? { cueIndexes: [...progress.cueIndexes] } : {}) };
      if (processedSubtitleGaps(record)) Object.assign(result.subtitleTranslationProgress,
        { processingComplete: true, processedCues: progress.totalCues });
      if (partial) result.subtitleTranslationPartial = partial;
      if (!result.subtitleTranslationProgress.complete) {
        delete result.subtitleLanguage;
        delete result.subtitleTranslation;
        result.status = 'partial';
      }
    } catch (error) {
      delete result.subtitleTranslationProgress;
      delete result.subtitleTranslationPartial;
      delete result.subtitleLanguage;
      delete result.subtitleTranslation;
      result.subtitleError = error.message;
      result.status = 'partial';
      result.warnings.push('한국어 번역 진행 기록이나 전송 크기를 확인하지 못해 완성본으로 표시하지 않았습니다. 원문 대사는 보관했습니다.');
    }
  }
  result.frames = original.frames.map(frame => ({ ...frame, caption: String(record.frames?.find(f => f.filename === frame.filename)?.caption || '').slice(0, 2000) }));
  if (['completed', 'partial', 'failed'].includes(record.subtitleRepairStatus)) {
    const translationComplete = result.subtitleLanguage === 'ko' && result.subtitleTranslation?.length === result.transcript.length && result.transcript.length > 0
      || result.subtitleTranslationProgress?.translationComplete === true && result.subtitleTranslationPartial?.length === result.transcript.length && result.transcript.length > 0;
    result.subtitleRepairStatus = record.subtitleRepairStatus === 'completed' && !translationComplete
      ? result.subtitleTranslationPartial?.length ? 'partial' : 'failed' : record.subtitleRepairStatus;
  }
  const provenance = sanitizeAnalysisProvenance(record.analysisProvenance);
  if (provenance) result.analysisProvenance = provenance;
  // Normalization or truncation must not carry a terminal marker past a source,
  // timing, status or hard-stop mismatch in the transported record.
  if (!processedSubtitleGaps(result) && result.subtitleTranslationProgress) {
    delete result.subtitleTranslationProgress.processingComplete;
    delete result.subtitleTranslationProgress.processedCues;
  }
  return result;
}

function translationOnlyResult(record, received) {
  // The host cannot replace this PC's original transcript, images or summary
  // while restoring a translation. Validate every subtitle against local cues.
  const validated = publicRecord({ ...received, transcript: record.transcript, transcriptionQuality: record.transcriptionQuality }, { ...record, frames: [] });
  if (validated.subtitleTranslation) validated.subtitleTranslation = validated.subtitleTranslation.map((cue, index) => ({ ...cue,
    ...(record.transcript[index].id === undefined ? {} : { id: record.transcript[index].id }) }));
  if (record.transcriptionQuality?.profile === 'accurate' && !isCurrentFullTranscription(record, 'accurate')
    && validated.subtitleLanguage === 'ko' && validated.subtitleTranslation?.length && !validated.subtitleTranslationProgress) {
    // A complete translation of retained cues is still a partial subtitle when
    // the source coverage audit remains incomplete. Keep the actual cue times.
    const partial = validated.subtitleTranslation.map((cue, index) => ({ ...cue,
      ...(record.transcript[index].id === undefined ? {} : { id: record.transcript[index].id }) }));
    const progress = { version: 1, sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(record.transcript.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex'),
      totalCues: record.transcript.length, completedCues: partial.length, language: 'ko', complete: false,
      sourceComplete: false, translationComplete: true, sourceProcessed: isProcessedTranscription(record, 'accurate'), sourceAuditComplete: false };
    validatePartialTranslation({ transcript: record.transcript, subtitleTranslationPartial: partial, subtitleTranslationProgress: progress });
    delete validated.subtitleLanguage;
    delete validated.subtitleTranslation;
    validated.subtitleTranslationPartial = partial;
    validated.subtitleTranslationProgress = progress;
    validated.warnings.push('원문 음성의 검수가 끝나지 않아 번역된 대사를 부분 자막으로 보관했습니다.');
  }
  // Retained sparse subtitles need set-based preservation. A later failed
  // repair may approve cues after an earlier gap without returning the old
  // prefix. Keep both strictly validated subsets of this exact local source.
  if (record.subtitleTranslationProgress?.version === 2 || validated.subtitleTranslationProgress?.version === 2) {
    try {
      validatePartialTranslation(record);
      validatePartialTranslation(validated);
      const byIndex = new Map();
      const add = (candidate, replace) => {
        const progress = candidate.subtitleTranslationProgress;
        const indexes = progress.version === 2 ? progress.cueIndexes : candidate.subtitleTranslationPartial.map((_, index) => index);
        candidate.subtitleTranslationPartial.forEach((cue, offset) => {
          const index = indexes[offset];
          if (replace || !byIndex.has(index)) byIndex.set(index, { start: record.transcript[index].start, end: record.transcript[index].end,
            text: cue.text.trim(), ...(record.transcript[index].id === undefined ? {} : { id: record.transcript[index].id }) });
        });
      };
      add(record, false); add(validated, validated.subtitleRepairStatus !== 'failed');
      const indexes = [...byIndex.keys()].sort((left, right) => left - right);
      const sparse = indexes.some((index, offset) => index !== offset);
      validated.subtitleTranslationPartial = indexes.map(index => byIndex.get(index));
      validated.subtitleTranslationProgress = { ...validated.subtitleTranslationProgress, version: sparse ? 2 : 1,
        completedCues: indexes.length, complete: false,
        translationComplete: indexes.length === record.transcript.length && validated.subtitleTranslationProgress.translationComplete === true };
      delete validated.subtitleTranslationProgress.cueIndexes;
      if (sparse) validated.subtitleTranslationProgress.cueIndexes = indexes;
      validatePartialTranslation(validated);
    } catch (_) { /* Invalid or unrelated saved data cannot authorize a merge. */ }
  }
  const result = { ...record };
  const hasFullTranslation = validated.subtitleLanguage === 'ko' && Boolean(validated.subtitleTranslation?.length);
  const hasPartialTranslation = Boolean(validated.subtitleTranslationPartial?.length);
  const hasProcessedGaps = processedSubtitleGaps(validated) !== null;
  const repairStatus = validated.subtitleRepairStatus;
  let retainedCues = 0;
  if (record.subtitleLanguage === 'ko') {
    try {
      validateTranslation(record.subtitleTranslation, record.transcript);
      if (record.subtitleTranslation.every((cue, index) => cue.id === undefined || cue.id === record.transcript[index].id)) {
        retainedCues = record.transcript.length;
      }
    } catch (_) { /* An invalid old full translation is not a preservation proof. */ }
  }
  try { retainedCues = Math.max(retainedCues, validatePartialTranslation(record).length); }
  catch (_) { /* Only a fingerprint- and timing-validated old prefix counts. */ }
  const extendedFailedPrefix = repairStatus === 'failed' && hasPartialTranslation
    && validated.subtitleTranslationPartial.length > retainedCues;
  // A later batch can fail after earlier batches were approved. Keep that new
  // progress without changing the failed outcome or shortening usable output.
  if ((hasFullTranslation || hasPartialTranslation || hasProcessedGaps) && repairStatus !== 'failed' || extendedFailedPrefix) {
    for (const key of ['subtitleLanguage', 'subtitleTranslation', 'subtitleTranslationPartial', 'subtitleTranslationProgress', 'subtitleError']) {
      delete result[key];
      if (validated[key] !== undefined) result[key] = validated[key];
    }
  } else if (validated.subtitleError !== undefined) {
    result.subtitleError = validated.subtitleError;
  }
  delete result.subtitleRepairStatus;
  if (repairStatus !== undefined) result.subtitleRepairStatus = repairStatus;
  if (validated.subtitleDiagnostic) result.subtitleDiagnostic = sanitizeDiagnosticEvent(validated.subtitleDiagnostic);
  else if (repairStatus === 'completed') delete result.subtitleDiagnostic;
  // The upload contains no original analysis status or failure reason. A host
  // may still call its record "pending" after a successful text-only repair.
  // Preserve this PC's analysis error and derive status from the local source.
  const sourceUncertain = record.transcriptionQuality?.complete === false || validated.subtitleTranslationProgress?.sourceComplete === false;
  result.status = repairStatus === 'completed' && hasFullTranslation && record.status === 'completed' && !sourceUncertain ? 'completed' : 'partial';
  if (!hasFullTranslation && !hasPartialTranslation && !hasProcessedGaps) {
    result.subtitleError ||= '서버가 유효한 한국어 번역 자막을 반환하지 않았습니다. 저장된 원문은 보관했습니다.';
  }
  result.warnings = [...new Set([...(Array.isArray(record.warnings) ? record.warnings : []), ...validated.warnings])];
  const previous = sanitizeAnalysisProvenance(record.analysisProvenance);
  const updated = sanitizeAnalysisProvenance(validated.analysisProvenance);
  if (previous?.analysis || updated?.translation) result.analysisProvenance = { schemaVersion: 1,
    ...(previous?.analysis ? { analysis: previous.analysis } : {}), ...(updated?.translation ? { translation: updated.translation } : {}) };
  if (!processedSubtitleGaps(result) && result.subtitleTranslationProgress) {
    delete result.subtitleTranslationProgress.processingComplete;
    delete result.subtitleTranslationProgress.processedCues;
  }
  return result;
}

function createLanAnalysis({ dataDir, processPackage, connectionStore, journalIO = fsp, managedCloseTimeoutMs = 30000, diagnosticsStore } = {}) {
  if (typeof dataDir !== 'string' || typeof processPackage !== 'function') throw new Error('분석 서버 설정이 필요합니다.');
  if (!Number.isSafeInteger(managedCloseTimeoutMs) || managedCloseTimeoutMs < 1 || managedCloseTimeoutMs > 30000) throw new Error('관리 업데이트의 연결 종료 대기 시간이 올바르지 않습니다.');
  connectionStore = connectionStore || require('./connection-store').createConnectionStore({ dataDir });
  diagnosticsStore = diagnosticsStore || createDiagnosticsStore({ dataDir });
  const app = express();
  app.disable('x-powered-by');
  const jobs = new Map();
  const queue = [];
  const sockets = new Set();
  const responses = new Set();
  const uploading = new Set();
  let server = null;
  let connectionCode = '';
  let activeJob = null;
  let activeTranslationJob = null;
  let reserved = 0;
  let stopping = false;
  let startPromise = null;
  let stopPromise = null;
  let updateDraining = false, persisting = 0, settling = 0;
  let terminalJournalError = '', restorePromise = null;
  let lastStartOptions = null, updateResumeOptions = null;
  const activeCount = () => Number(Boolean(activeJob)) + Number(Boolean(activeTranslationJob));
  function diagnostic(job, value, { legacy = false } = {}) {
    const clean = sanitizeDiagnosticEvent(value);
    return diagnosticsStore.append({ ...clean, source: 'host', jobId: job.id, serverJobId: job.id,
      ...job.diagnosticClient, clientAddress: job.clientAddress, videoName: job.record?.name || job.result?.name,
      ...(job.operation ? { operation: job.operation } : legacy ? {} : { operation: 'analysis' }),
      ...(legacy ? {} : { serverVersion: APP_VERSION }) }).catch(() => {});
  }
  function terminalDiagnostic(job, { legacy = false } = {}) {
    const result = job.result || {}, partial = result.status === 'partial' || result.error || result.subtitleError || result.summaryError;
    const failed = job.status === 'failed' || partial, cancelled = job.status === 'cancelled';
    const processedGaps = job.status === 'completed' && processedSubtitleGaps(result) !== null;
    const detail = result.subtitleDiagnostic || result.analysisDiagnostic || {};
    const failure = result.subtitleError || result.summaryError || result.error || job.error;
    const provenance = sanitizeAnalysisProvenance(result.analysisProvenance);
    const stamp = provenance?.translation || provenance?.analysis;
    return diagnostic(job, { ...detail, id: 'terminal-' + job.id, ...(legacy ? { recordedAt: job.finishedAt, originalRecordedAt: job.finishedAt,
      ...(stamp?.serverVersion ? { serverVersion: stamp.serverVersion } : {}), ...(stamp?.clientVersion ? { clientVersion: stamp.clientVersion } : {}) } : {}),
      event: legacy ? 'imported_terminal' : processedGaps ? 'partial' : 'completed', level: cancelled || processedGaps ? 'warning' : failed ? 'error' : 'info',
      stage: detail.stage || (result.subtitleError ? 'translation' : result.summaryError ? 'summary' : job.status === 'failed' ? 'processing' : 'completed'),
      status: cancelled ? 'cancelled' : job.status === 'failed' ? 'failed' : failed ? 'partial' : 'completed', percent: job.percent,
      totalCues: result.subtitleTranslationProgress?.totalCues ?? result.transcript?.length,
      completedCues: result.subtitleTranslationProgress?.completedCues ?? result.subtitleTranslation?.length ?? result.subtitleTranslationPartial?.length,
      ...(cancelled ? { code: 'ANALYSIS_CANCELLED' } : processedGaps ? { code: 'SUBTITLE_CUES_PENDING' } : !failure ? { code: failed ? 'ANALYSIS_PARTIAL' : 'ANALYSIS_COMPLETED' }
        : detail.code ? { code: detail.code } : classifyDiagnosticError(failure)) }, { legacy });
  }

  function status() {
    return { running: Boolean(server?.listening) && !stopping, port: server?.address()?.port || null,
      connectionCode: stopping ? '' : connectionCode, active: activeCount(), queued: queue.length };
  }

  function snapshot(job) {
    return { id: job.id, status: job.status, stage: job.stage, percent: job.percent,
      ...(job.frameFingerprints ? { frameFingerprints: job.frameFingerprints } : {}),
      ...(job.status === 'running' && job.phaseProgress ? { phaseProgress: ageProgressDetails(job.phaseProgress,
        Math.max(0, (Date.now() - (job._phaseProgressAt || Date.now())) / 1000)) } : {}),
      createdAt: job.createdAt, finishedAt: job.finishedAt || null, error: job.error || '', result: job.result || null };
  }

  function getUpdateStatus() {
    return { running: Boolean(server?.listening) && !stopping, port: server?.address()?.port || null,
      draining: updateDraining, active: activeCount(), queued: queue.length, uploading: reserved,
      persisting, settling, busy: Boolean(activeCount() || queue.length || reserved || persisting || settling || startPromise || stopPromise),
      blocked: Boolean(terminalJournalError), ...(terminalJournalError ? { error: terminalJournalError } : {}) };
  }

  async function persistTerminal(job, outcome) {
    persisting++;
    const target = path.join(job.dir, 'terminal.json');
    const temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    let handle;
    try {
      const terminal = { schemaVersion: 1, ...snapshot({ ...job, ...outcome }), originalFrames: job.originalFrames, operation: job.operation || 'analysis',
        ...(job.diagnosticClient ? { diagnosticClient: job.diagnosticClient } : {}), ...(job.clientAddress ? { clientAddress: job.clientAddress } : {}) };
      handle = await journalIO.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(terminal), 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await journalIO.rename(temporary, target);
    } catch (_) {
      // Keep the result available to its current client, but never hand this
      // process's ownership away unless it can also survive the handoff.
      terminalJournalError = '완료된 분석 작업의 재시작 복구 기록을 저장하지 못했습니다.';
      await diagnostic(job, { event: 'error', level: 'error', status: 'failed', stage: 'saving', code: 'RESULT_SAVE_FAILED' });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await journalIO.unlink(temporary).catch(() => {});
      persisting--;
    }
  }

  async function publishTerminal(job, outcome) {
    const terminal = { ...outcome, finishedAt: new Date().toISOString() };
    await persistTerminal(job, terminal);
    Object.assign(job, terminal);
    await terminalDiagnostic(job);
  }

  async function restoreTerminals() {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      const directory = path.join(dataDir, 'remote', 'jobs');
      const names = await journalIO.readdir(directory);
      for (const id of names.filter(name => SAFE_ID.test(name))) {
        if (jobs.has(id)) continue;
        const dir = path.join(directory, id), target = path.join(dir, 'terminal.json');
        try {
          const directoryStat = await journalIO.lstat(dir);
          if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid job directory');
          const stat = await journalIO.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) throw new Error('Invalid terminal journal');
          const saved = JSON.parse(await journalIO.readFile(target, 'utf8'));
          if (saved.schemaVersion !== 1 || saved.id !== id || !TERMINAL.has(saved.status)
            || saved.operation !== undefined && !['analysis', 'translation-only'].includes(saved.operation)
            || !Number.isFinite(Date.parse(saved.createdAt)) || !Number.isFinite(Date.parse(saved.finishedAt))
            || !Array.isArray(saved.originalFrames) || saved.originalFrames.length > 20
            || saved.originalFrames.some(frame => !frame || !safeFrameFilename(frame.filename)
              || typeof frame.timestamp !== 'number' || !Number.isFinite(frame.timestamp) || frame.timestamp < 0)
            || new Set(saved.originalFrames.map(frame => frame.filename.toLowerCase())).size !== saved.originalFrames.length
            || saved.status === 'completed' && (!saved.result || typeof saved.result !== 'object' || Array.isArray(saved.result))) {
            throw new Error('Invalid terminal journal');
          }
          const originalFrames = saved.originalFrames.map(({ filename, timestamp }) => ({ filename, timestamp, caption: '' }));
          const result = saved.result ? publicRecord(saved.result, { ...saved.result, id, path: 'remote-upload://' + id, frames: originalFrames }) : null;
          const fingerprints = frameFingerprints(saved.frameFingerprints, originalFrames);
          const provenance = sanitizeAnalysisProvenance(result?.analysisProvenance);
          const operation = saved.operation || (provenance?.translation ? 'translation-only' : provenance?.analysis ? 'analysis' : undefined);
          jobs.set(id, { id, dir, framesDir: path.join(dir, 'frames'), originalFrames, status: saved.status,
            ...(fingerprints ? { frameFingerprints: fingerprints } : {}),
            ...(operation ? { operation } : {}),
            stage: textValue(saved.stage, 200, '작업 단계'), percent: Math.max(0, Math.min(100, Number(saved.percent) || 0)),
            createdAt: saved.createdAt, finishedAt: saved.finishedAt, error: textValue(saved.error, 2000, '작업 오류'), result,
            ...(saved.diagnosticClient ? { diagnosticClient: validateDiagnosticClient(saved.diagnosticClient) } : {}),
            ...(sanitizeDiagnosticEvent(saved).clientAddress ? { clientAddress: sanitizeDiagnosticEvent(saved).clientAddress } : {}) });
          await terminalDiagnostic(jobs.get(id), { legacy: true });
        } catch (error) {
          if (error.code !== 'ENOENT') terminalJournalError = '완료된 분석 작업의 재시작 복구 기록을 읽지 못했습니다.';
        }
      }
    })();
    return restorePromise;
  }

  async function cleanupAudio(job) {
    if (job.audioPath) await fsp.rm(job.audioPath, { force: true }).catch(() => {});
  }

  function prune() {
    for (const [id, job] of jobs) {
      if (jobs.size < 100) break;
      if (TERMINAL.has(job.status)) {
        jobs.delete(id);
        fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  function runNext() {
    if (stopping || !server?.listening) return;
    const index = queue.findIndex(job => job.operation === 'translation-only' ? !activeTranslationJob : !activeJob);
    if (index < 0) return;
    const [job] = queue.splice(index, 1);
    if (job.operation === 'translation-only') activeTranslationJob = job;
    else activeJob = job;
    job.status = 'running';
    job.stage = '이 PC에서 분석 중';
    diagnostic(job, { event: 'started', level: 'info', status: 'running', code: 'ANALYSIS_STARTED' });
    job.task = (async () => {
      let outcome;
      try {
        const result = await processPackage({ record: job.record, framesDir: job.framesDir, audioPath: job.audioPath, transcribeAudio: job.transcribeAudio,
          transcriptLanguage: job.transcriptLanguage, subtitleLanguage: job.subtitleLanguage, subtitleQuality: job.subtitleQuality,
          ...(job.operation ? { operation: job.operation, forceTranslation: job.forceTranslation } : {}) }, {
          signal: job.controller.signal,
          onDiagnostic(event) { diagnostic(job, event); },
          onProgress(stage, percent, details) {
            const previousStage = job.stage;
            job.stage = String(stage || '').slice(0, 200);
            job.percent = Math.max(0, Math.min(100, Number(percent) || 0));
            const phaseProgress = normalizeProgressDetails(details);
            if (phaseProgress) { job.phaseProgress = phaseProgress; job._phaseProgressAt = Date.now(); }
            else delete job.phaseProgress;
            if (previousStage !== job.stage) diagnostic(job, { event: 'stage_changed', stage: stageIdentity(stage).stageKey,
              status: 'running', percent: job.percent, code: 'ANALYSIS_STAGE' });
          }
        });
        if (job.controller.signal.aborted) throw abortError();
        const processedRecord = result || {};
        stampAnalysisProvenance(processedRecord, { operation: job.operation || 'analysis', serverVersion: APP_VERSION });
        outcome = { status: 'completed', stage: '분석 완료', percent: 100,
          result: publicRecord(processedRecord, { ...job.record, id: job.id, path: 'remote-upload://' + job.id, frames: job.originalFrames }) };
        if (job.operation !== 'translation-only') {
          const fingerprints = {};
          // These are the actual files served by the image endpoint, after all
          // processing. A client can keep an identical local original instead
          // of downloading the same JPEG a second time over Wi-Fi.
          for (const frame of job.originalFrames) {
            const digest = await localFrameFingerprint(path.join(job.framesDir, frame.filename), job.controller.signal);
            if (digest) fingerprints[frame.filename] = digest;
          }
          outcome.frameFingerprints = fingerprints;
        }
      } catch (error) {
        const cancelled = job.controller.signal.aborted;
        outcome = { status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? '분석 중지됨' : '분석 실패',
          // Optional image verification starts only after the substantive
          // analysis result exists. Retain that result if this later phase is
          // interrupted; cancellation must not discard already produced cues.
          ...(outcome?.result ? { result: outcome.result } : {}),
          error: cancelled ? '분석을 중지했습니다.' : String(error.message || error).slice(0, 2000) };
      } finally {
        // A terminal response is the cleanup boundary: clients must not observe
        // completed/failed/cancelled while its uploaded audio is still being removed.
        delete job.phaseProgress;
        job.stage = '전송된 음성 정리 중';
        await cleanupAudio(job);
        if (job.controller.signal.aborted) outcome = { ...outcome, status: 'cancelled', stage: '분석 중지됨', error: '분석을 중지했습니다.' };
        job.stage = '완료된 분석 기록 보관 중';
        await publishTerminal(job, outcome);
        if (activeJob === job) activeJob = null;
        if (activeTranslationJob === job) activeTranslationJob = null;
        setImmediate(runNext);
      }
    })();
    // Translation-only work never runs ASR. Give at most one such text job a
    // separate lane so a long GPU transcription cannot block subtitle repair.
    setImmediate(runNext);
  }

  app.use((req, res, next) => {
    responses.add(res);
    const release = () => { responses.delete(res); };
    res.once('finish', release); res.once('close', release);
    res.setHeader('Cache-Control', 'no-store');
    if (!privateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: '같은 사설 네트워크의 PC만 연결할 수 있습니다.' });
    if (Object.keys(req.query).length) return res.status(400).json({ error: '연결 코드는 Authorization 헤더로 보내 주세요.' });
    const received = /^Bearer ([a-zA-Z0-9_-]{24,128})$/.exec(req.headers.authorization || '')?.[1] || '';
    const supplied = Buffer.from(received);
    const expected = Buffer.from(connectionCode);
    if (!connectionCode || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: '분석 서버 연결 코드가 올바르지 않습니다.' });
    if (stopping) return res.status(503).json({ error: '분석 서버가 종료 중입니다.' });
    next();
  });

  app.get('/v1/status', (req, res) => res.json({ ready: true, protocol: 1, appVersion: APP_VERSION, active: activeCount(), queued: queue.length, capabilities: ['timed-subtitles-v1', 'subtitle-quality-v1', 'subtitle-quality-v2', 'subtitle-quality-v3', 'subtitle-translation-only-v1', 'managed-update-v1', 'diagnostics-v1', 'original-frame-fingerprints-v1', 'turbo-subtitles-v1', 'sparse-subtitles-v1'] }));
  app.post('/v1/diagnostics/report', express.json({ limit: '64kb', strict: true }), async (req, res) => {
    if (updateDraining) return res.status(503).json({ error: '분석 서버가 업데이트를 준비 중입니다. 진단 기록은 연결 PC에 보관됩니다.' });
    persisting++;
    let valid = false;
    try {
      const body = req.body;
      if (!body || Object.keys(body).some(key => !['clientId', 'clientName', 'clientVersion', 'reports'].includes(key))
        || !Array.isArray(body.reports) || !body.reports.length || body.reports.length > 50) return res.status(400).json({ error: '진단 보고 형식이 올바르지 않습니다.' });
      const client = validateDiagnosticClient(Object.fromEntries(['clientId', 'clientName', 'clientVersion'].filter(key => body[key] !== undefined).map(key => [key, body[key]])));
      const reports = body.reports.map(item => {
        if (!item || Object.keys(item).some(key => !['reportId', 'event'].includes(key)) || !/^[a-f0-9]{64}$/.test(item.reportId)
          || !item.event || typeof item.event !== 'object' || Array.isArray(item.event)) throw new Error('Invalid report');
        return item;
      });
      valid = true;
      const acceptedReportIds = [];
      for (const item of reports) {
        const event = sanitizeDiagnosticEvent(item.event);
        await diagnosticsStore.append({ ...event, clientId: client.clientId, clientName: client.clientName,
          ...(event.event === 'history-imported' ? {} : { clientVersion: event.clientVersion || client.clientVersion }),
          reporterVersion: client.clientVersion, id: item.reportId, source: 'client', clientAddress: req.socket.remoteAddress });
        acceptedReportIds.push(item.reportId);
      }
      res.json({ acceptedReportIds });
    } catch (_) { res.status(valid ? 500 : 400).json({ error: '진단 보고를 저장하지 못했습니다.' }); }
    finally { persisting--; }
  });
  app.use((error, req, res, next) => {
    if (req.path !== '/v1/diagnostics/report') return next(error);
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: '진단 보고가 허용된 형식이나 크기를 초과했습니다.' });
  });

  const storage = {
    _handleFile(req, file, callback) {
      const isImage = file.fieldname === 'frames';
      const destination = isImage ? req.uploadFramesDir : req.uploadDir;
      const filename = file.originalname;
      const signatureLength = !isImage && filename === 'audio.flac' ? 4 : 3;
      const target = path.join(destination, filename);
      let size = 0;
      let signature = Buffer.alloc(0);
      const validator = new Transform({
        transform(chunk, encoding, done) {
          size += chunk.length;
          if (size > (isImage ? MAX_IMAGE : MAX_AUDIO)) return done(new Error(isImage ? '이미지 한 장은 5MB 이하여야 합니다.' : '음성은 250MB 이하여야 합니다.'));
          if (signature.length < signatureLength) signature = Buffer.concat([signature, chunk]).subarray(0, signatureLength);
          if (signature.length === signatureLength) {
            const valid = isImage ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
              : filename === 'audio.flac' ? signature.toString('ascii') === 'fLaC'
                : signature.toString('ascii') === 'ID3' || (signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0);
            if (!valid) return done(new Error(isImage ? 'JPEG 이미지만 전송할 수 있습니다.' : 'MP3 또는 FLAC 음성만 전송할 수 있습니다.'));
          }
          done(null, chunk);
        },
        flush(done) { done(signature.length < signatureLength ? new Error('빈 파일은 전송할 수 없습니다.') : null); }
      });
      pipeline(file.stream, validator, fs.createWriteStream(target, { flags: 'wx' }), error => {
        if (error) fsp.rm(target, { force: true }).catch(() => {});
        callback(error, error ? undefined : { destination, filename, path: target, size });
      });
    },
    _removeFile(req, file, callback) { fs.unlink(file.path, error => callback(error?.code === 'ENOENT' ? null : error)); }
  };
  const upload = multer({ storage, preservePath: true,
    limits: { files: 21, fields: 1, parts: 22, fieldSize: MAX_METADATA, fileSize: MAX_AUDIO, fieldNameSize: 100 },
    fileFilter(req, file, callback) {
      const image = file.fieldname === 'frames' && safeFrameFilename(file.originalname) && file.mimetype === 'image/jpeg';
      const audio = file.fieldname === 'audio' && ((file.originalname === 'audio.mp3' && file.mimetype === 'audio/mpeg')
        || (file.originalname === 'audio.flac' && file.mimetype === 'audio/flac'));
      const key = file.fieldname + ':' + file.originalname.toLowerCase();
      if ((!image && !audio) || req.uploadNames.has(key)) return callback(new Error('파일명, 파일 종류 또는 중복 파일이 올바르지 않습니다.'));
      req.uploadNames.add(key);
      callback(null, true);
    }
  }).fields([{ name: 'frames', maxCount: 20 }, { name: 'audio', maxCount: 1 }]);

  app.post('/v1/jobs', async (req, res) => {
    if (updateDraining) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: '분석 서버가 업데이트를 준비 중입니다. 진행 중인 작업이 끝나면 다시 연결됩니다.', code: 'VIDEORANDOM_UPDATE_DRAINING' });
    }
    if (queue.length + activeCount() + reserved >= 20) return res.status(429).json({ error: '분석 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.' });
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0) return res.status(411).json({ error: '전송할 파일 크기 정보가 필요합니다.' });
    if (length > MAX_UPLOAD) return res.status(413).json({ error: '전송할 분석 자료가 너무 큽니다.' });
    reserved++;
    uploading.add(req);
    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.resolve(dataDir, 'remote', 'jobs', id);
    req.uploadDir = dir;
    req.uploadFramesDir = path.join(dir, 'frames');
    req.uploadNames = new Set();
    let accepted = false;
    try {
      await fsp.mkdir(req.uploadFramesDir, { recursive: true });
      if (stopping || req.aborted) throw abortError();
      await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
      if (stopping || req.aborted) throw abortError();
      if (typeof req.body?.metadata !== 'string' || Object.keys(req.body).length !== 1) throw new Error('영상 정보가 필요합니다.');
      const metadata = validateMetadata(JSON.parse(req.body.metadata));
      const files = req.files?.frames || [];
      if (files.length !== metadata.frames.length || metadata.frames.some(frame => !files.some(file => file.filename === frame.filename))) throw new Error('대표 이미지 목록과 전송된 파일이 일치하지 않습니다.');
      const audioPath = req.files?.audio?.[0]?.path || null;
      if (metadata.operation === 'translation-only' && audioPath) throw new Error('번역 복구에는 음성 파일을 전송할 수 없습니다.');
      if (metadata.transcribeAudio && !audioPath) throw new Error('전체 대사 인식을 위한 음성 파일이 필요합니다.');
      if (!metadata.transcribeAudio && audioPath) throw new Error('음성 인식 설정 없이 음성 파일을 전송할 수 없습니다.');
      if (metadata.operation !== 'translation-only' && metadata.subtitleQuality === 'accurate' && metadata.subtitleLanguage === 'ko' && metadata.hasAudio) {
        if (!audioPath && !isCurrentFullTranscription(metadata, 'accurate')) throw new Error('정확도 우선 한국어 자막에는 전체 음성 또는 최신 검수 방식으로 확인한 전체 인식 기록이 필요합니다.');
        if (audioPath && req.files.audio[0].filename !== 'audio.flac') throw new Error('정확도 우선 분석에는 무손실 FLAC 음성을 전송해 주세요.');
      }
      if (metadata.operation !== 'translation-only' && metadata.subtitleQuality === 'turbo' && metadata.hasAudio) {
        if (!audioPath && (!isProcessedTranscription(metadata, 'turbo') || metadata.transcriptionQuality?.complete !== true)) throw new Error('초고속 분석에는 전체 음성 또는 초고속 모드로 끝까지 인식한 대사 기록이 필요합니다.');
        if (audioPath && path.extname(audioPath).toLowerCase() !== '.flac') throw new Error('초고속 분석에는 무손실 FLAC 음성을 전송해 주세요.');
      }
      const { transcribeAudio, transcriptLanguage, subtitleLanguage, subtitleQuality, operation, forceTranslation, diagnosticClient, ...baseRecord } = metadata;
      const record = { ...baseRecord, transcriptLanguage: detectedLanguage(transcriptLanguage) || detectedLanguage(baseRecord.transcriptionQuality?.language), hasAudio: metadata.hasAudio || Boolean(audioPath), id, path: 'remote-upload://' + id, summary: '', plot: '', dialogueSummary: '', labels: [], warnings: [], status: 'pending', analyzedAt: new Date().toISOString() };
      const job = { id, dir, record, originalFrames: metadata.frames.map(frame => ({ ...frame })), framesDir: req.uploadFramesDir, audioPath, transcribeAudio, transcriptLanguage, subtitleLanguage, subtitleQuality, operation, forceTranslation, controller: new AbortController(),
        status: 'queued', stage: '이 PC의 분석 순서 대기', percent: 0, createdAt: new Date().toISOString(),
        diagnosticClient, clientAddress: req.socket.remoteAddress };
      prune();
      if (jobs.size >= 100) throw new Error('저장할 수 있는 분석 작업 수를 초과했습니다.');
      jobs.set(id, job);
      queue.push(job);
      accepted = true;
      await diagnostic(job, { event: 'accepted', status: 'queued', code: 'ANALYSIS_ACCEPTED' });
      res.status(202).json(snapshot(job));
      setImmediate(runNext);
    } catch (error) {
      if (!res.headersSent && !req.aborted && !res.destroyed) res.status(error.code?.startsWith('LIMIT_') ? 413 : 400).json({ error: String(error.message || '분석 자료 전송 실패').slice(0, 2000) });
    } finally {
      if (!accepted) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      reserved--;
      uploading.delete(req);
    }
  });

  app.get('/v1/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '분석 작업을 찾을 수 없습니다.' });
    res.json(snapshot(job));
  });

  app.post('/v1/jobs/:id/cancel', async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: '분석 작업을 찾을 수 없습니다.' });
    if (!TERMINAL.has(job.status)) {
      job.controller.abort();
      const index = queue.indexOf(job);
      if (index >= 0) {
        queue.splice(index, 1);
        job.status = 'cancelling';
        job.stage = '전송된 음성 정리 중';
        settling++;
        try {
          await cleanupAudio(job);
          await publishTerminal(job, { status: 'cancelled', stage: '분석 중지됨' });
        } finally { settling--; }
      } else job.status = 'cancelling';
    }
    res.json(snapshot(job));
  });

  app.get('/v1/jobs/:id/frames/:filename', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || !SAFE_ID.test(req.params.id) || !safeFrameFilename(req.params.filename) || !job.originalFrames.some(frame => frame.filename === req.params.filename)) return res.status(404).json({ error: '대표 이미지를 찾을 수 없습니다.' });
    res.type('jpeg').sendFile(path.join(job.framesDir, req.params.filename), error => {
      if (error && !res.headersSent) res.status(404).json({ error: '대표 이미지 파일이 없습니다.' });
    });
  });

  async function start({ port = 3001, host = '0.0.0.0' } = {}) {
    if (stopPromise) await stopPromise;
    if (server?.listening) return status();
    if (startPromise) return startPromise;
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) throw new Error('분석 서버 주소 또는 포트가 올바르지 않습니다.');
    stopping = false;
    startPromise = (async () => {
      connectionCode = await connectionStore.getHostCode();
      await fsp.mkdir(path.join(dataDir, 'remote', 'jobs'), { recursive: true });
      await restoreTerminals();
      const candidate = http.createServer(app);
      candidate.requestTimeout = 10 * 60 * 1000;
      candidate.headersTimeout = 15000;
      candidate.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(port, host, resolve); });
        server = candidate;
        lastStartOptions = { port: candidate.address().port, host };
        setImmediate(runNext);
        return status();
      } catch (error) {
        connectionCode = '';
        candidate.close();
        throw error;
      }
    })();
    try { return await startPromise; } finally { startPromise = null; }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) await startPromise.catch(() => {});
      stopping = true;
      connectionCode = '';
      for (const job of queue.splice(0)) {
        job.controller.abort();
        job.status = 'cancelling';
        job.stage = '전송된 음성 정리 중';
        await cleanupAudio(job);
        await publishTerminal(job, { status: 'cancelled', stage: '분석 서버 종료' });
      }
      activeJob?.controller.abort();
      activeTranslationJob?.controller.abort();
      for (const req of uploading) req.destroy();
      const previous = server;
      server = null;
      if (previous) {
        const closed = new Promise(resolve => previous.close(resolve));
        for (const socket of sockets) socket.destroy();
        await closed;
      }
      // A provider receives the abort signal; stop does not hang on an uncooperative provider.
      const activeTasks = [activeJob?.task, activeTranslationJob?.task].filter(Boolean);
      if (activeTasks.length) await Promise.race([Promise.allSettled(activeTasks), new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref?.(); })]);
      for (const job of jobs.values()) await cleanupAudio(job);
      await diagnosticsStore.flush().catch(() => {});
      return status();
    })();
    try { return await stopPromise; } finally { stopPromise = null; }
  }

  function prepareUpdate() {
    if (!updateDraining) updateResumeOptions = server?.listening && !stopping ? { ...lastStartOptions } : null;
    updateDraining = true;
    return getUpdateStatus();
  }
  async function cancelUpdate() {
    if (updateDraining && updateResumeOptions && !server?.listening) await start(updateResumeOptions);
    updateDraining = false;
    updateResumeOptions = null;
    return getUpdateStatus();
  }
  async function finishUpdate() {
    const current = getUpdateStatus();
    if (!updateDraining || current.busy || current.blocked) {
      throw Object.assign(new Error(current.error || '분석 서버의 진행 중인 작업과 전송이 끝나야 업데이트할 수 있습니다.'), { status: 409 });
    }
    // Unlike an explicit user stop, a managed handoff must let accepted GET
    // responses (especially representative images) finish sending. Terminal
    // jobs are already durable; close admission and idle connections without
    // destroying a socket that is still delivering one of their results.
    let timer;
    const closing = (async () => {
      stopping = true;
      const previous = server;
      if (previous) {
        for (const response of responses) {
          const socket = response.socket;
          if (!response.headersSent) response.setHeader('Connection', 'close');
          response.once('finish', () => {
            // Node 18 does not close every newly idle keep-alive socket during
            // server.close(). Send FIN only after all of its accepted responses
            // have finished; never truncate an image already being written.
            if (socket && !socket.destroyed && ![...responses].some(other => other.socket === socket)) socket.end();
            previous.closeIdleConnections?.();
          });
        }
        const closed = new Promise((resolve, reject) => previous.close(error => error ? reject(error) : resolve()));
        previous.closeIdleConnections?.();
        await closed;
      }
      // A timed-out handoff may already have reopened a replacement listener
      // on the same port while this old response finishes in the background.
      if (server === previous) { server = null; connectionCode = ''; }
    })();
    const operation = Promise.race([closing, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('분석 서버의 이미지 전송 연결이 끝나기를 기다렸지만 시간이 초과되었습니다. 업데이트를 보류하고 기존 서버를 다시 연결합니다.'),
        { code: 'UPDATE_LAN_CLOSE_TIMEOUT', status: 409 })), managedCloseTimeoutMs);
      timer.unref?.();
    })]);
    stopPromise = operation;
    try { await operation; }
    finally { clearTimeout(timer); if (stopPromise === operation) stopPromise = null; }
    return getUpdateStatus();
  }

  return { app, start, stop, status, prepareUpdate, cancelUpdate, getUpdateStatus, finishUpdate };
}

function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('분석 서버 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('분석 서버는 사설 네트워크의 http://주소:포트 형식으로 입력해 주세요.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !privateAddress(hostname)) throw new Error('같은 사설 네트워크의 PC 주소를 입력해 주세요.');
  if (!net.isIP(hostname) && (!/^[a-zA-Z0-9.-]{1,253}$/.test(hostname) || (hostname.includes('.') && !/\.(local|lan)$/i.test(hostname)))) throw new Error('사설 IP 주소 또는 같은 네트워크의 PC 이름을 입력해 주세요.');
  return url;
}

async function resolveRemoteUrl(value) {
  const url = validateRemoteUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(entry => !privateAddress(entry.address))) throw new Error('공인 인터넷 주소에는 영상을 전송할 수 없습니다. 같은 사설 네트워크의 PC 주소를 입력해 주세요.');
  return { hostname: addresses[0].address, port: Number(url.port || 80), hostHeader: url.host };
}

async function checkRemoteServer({ remoteUrl, connectionCode, signal } = {}) {
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode || '')) throw new Error('분석 PC에 표시된 연결 코드를 입력해 주세요.');
  const target = await resolveRemoteUrl(remoteUrl);
  const status = JSON.parse((await requestBuffer(target, '/v1/status', { headers: { Authorization: 'Bearer ' + connectionCode }, signal })).toString('utf8'));
  if (!status.ready || status.protocol !== 1) throw new Error('분석 PC의 서버를 먼저 켜 주세요.');
  return status;
}

function requestBuffer(target, endpoint, { method = 'GET', headers = {}, body, signal, maxBytes = 12 * MB, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let responseStatus;
    const rejectRequest = error => {
      if (responseStatus && error && typeof error === 'object') error.statusCode = responseStatus;
      reject(error);
    };
    const request = http.request({ hostname: target.hostname, port: target.port, path: endpoint, method, headers: { Host: target.hostHeader, ...headers } }, response => {
      responseStatus = response.statusCode;
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { request.destroy(new Error('분석 서버 응답이 너무 큽니다.')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', rejectRequest);
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let message = `분석 서버 요청 실패 (${response.statusCode})`;
          try { message = JSON.parse(buffer.toString('utf8')).error || message; } catch {}
          return rejectRequest(new Error(String(message).slice(0, 2000)));
        }
        resolve(buffer);
      });
    });
    const abort = () => request.destroy(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', rejectRequest);
    request.setTimeout(timeout, () => request.destroy(Object.assign(new Error('분석 서버 연결 시간이 초과되었습니다.'), { code: 'ETIMEDOUT' })));
    if (body?.pipe) { body.on('error', error => request.destroy(error)); body.pipe(request); }
    else request.end(body);
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function sendRemoteAnalysis(record, { remoteUrl, connectionCode, audioPath = null, dataDir, signal, onProgress = () => {}, onDiagnostic,
  diagnosticClient, transcriptLanguage, subtitleLanguage, subtitleQuality, operation, forceTranslation } = {}) {
  if (!/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode || '')) throw new Error('분석 PC에 표시된 연결 코드를 입력해 주세요.');
  if (!record || !SAFE_ID.test(record.id) || typeof dataDir !== 'string') throw new Error('전송할 영상 분석 결과가 올바르지 않습니다.');
  const translationOnly = operation === 'translation-only';
  if (operation !== undefined && !translationOnly) throw new Error('지원하지 않는 분석 작업입니다.');
  if (forceTranslation !== undefined && (!translationOnly || typeof forceTranslation !== 'boolean')) throw new Error('번역 복구 설정이 올바르지 않습니다.');
  if (translationOnly && audioPath) throw new Error('번역 복구에는 음성 파일을 전송할 수 없습니다.');
  const target = await resolveRemoteUrl(remoteUrl);
  const auth = { Authorization: 'Bearer ' + connectionCode };
  const jsonRequest = async (endpoint, options = {}) => JSON.parse((await requestBuffer(target, endpoint, { headers: auth, signal, ...options })).toString('utf8'));
  onProgress('분석 PC 연결 확인', 30);
  const host = await jsonRequest('/v1/status');
  if (!host.ready || host.protocol !== 1) throw new Error('분석 PC의 서버를 먼저 켜 주세요.');
  const languageHint = normalizeLanguageHint(transcriptLanguage);
  const subtitleChoice = translationOnly ? 'ko' : normalizeSubtitleLanguage(subtitleLanguage);
  const qualityChoice = normalizeSubtitleQuality(subtitleQuality);
  const supportsSubtitles = Array.isArray(host.capabilities) && host.capabilities.includes('timed-subtitles-v1');
  const supportsCurrentQuality = Array.isArray(host.capabilities) && host.capabilities.includes('subtitle-quality-v3');
  const supportsManagedUpdates = Array.isArray(host.capabilities) && host.capabilities.includes('managed-update-v1');
  const supportsDiagnostics = host.capabilities?.includes('diagnostics-v1');
  const supportsFrameFingerprints = host.capabilities?.includes('original-frame-fingerprints-v1');
  if (qualityChoice === 'turbo' && !host.capabilities?.includes('turbo-subtitles-v1')) {
    throw new Error('초고속 분석을 사용하려면 분석 서버 PC도 최신 버전으로 업데이트해 주세요.');
  }
  const reconnectDelays = supportsManagedUpdates ? UPDATE_RECONNECT_DELAYS : STATUS_RECONNECT_DELAYS;
  const supportsQuality = supportsCurrentQuality || Array.isArray(host.capabilities) && host.capabilities.some(value => ['subtitle-quality-v1', 'subtitle-quality-v2'].includes(value));
  if (translationOnly && !host.capabilities?.includes('subtitle-translation-only-v1')) throw new Error('한국어 번역만 복구하려면 분석 서버 PC도 새 버전으로 업데이트해 주세요. 전체 음성 분석으로 대체하지 않았습니다.');
  if (!supportsSubtitles && (languageHint !== 'auto' || subtitleChoice !== 'original')) {
    throw new Error('언어 지정과 한국어 자막을 사용하려면 분석 서버 PC도 새 버전으로 업데이트해 주세요. 원문 자막과 기존 분석은 현재 서버에서 사용할 수 있습니다.');
  }
  if (!supportsCurrentQuality && qualityChoice === 'accurate') throw new Error('최신 누락 검수를 적용한 정확도 우선 자막을 사용하려면 분석 서버 PC도 새 버전으로 업데이트해 주세요(1.6.6 이상). 이전 서버에서는 빠른 분석을 사용할 수 있습니다.');
  const sourceTranscript = record.transcript === undefined ? [] : record.transcript;
  const sanitizedTranscript = sanitizeRichSegments(sourceTranscript);
  if (!Array.isArray(sourceTranscript) || sanitizedTranscript.length !== sourceTranscript.length) {
    throw new Error('대사 기록이 50,000개 제한을 초과하거나 유효하지 않은 구간이 있습니다. 원문을 자르지 않고 전송을 중단했습니다.');
  }
  const metadata = {
    name: record.name, ext: record.ext, sizeMB: record.size || 0, duration: record.duration,
    transcript: supportsQuality ? sanitizedTranscript : sanitizedTranscript.map(cue => ({ start: cue.start, end: cue.end, text: cue.text })), transcriptSource: record.transcriptSource || 'none',
    frames: translationOnly ? [] : (record.frames || []).map(frame => ({ timestamp: frame.timestamp, filename: frame.filename })), transcribeAudio: Boolean(audioPath), hasAudio: record.hasAudio === true || Boolean(audioPath),
    ...(translationOnly ? { operation: 'translation-only', forceTranslation: forceTranslation === true } : {})
  };
  if (supportsDiagnostics && diagnosticClient) {
    try {
      metadata.diagnosticClient = validateDiagnosticClient({ ...diagnosticClient, recordId: record.id });
    } catch (_) { /* Optional diagnostics must never prevent the analysis upload. */ }
  }
  // Omit additive fields for older servers that only accept protocol 1 metadata.
  if (supportsSubtitles) {
    metadata.transcriptLanguage = languageHint;
    metadata.subtitleLanguage = subtitleChoice;
  }
  if (supportsQuality) {
    metadata.subtitleQuality = qualityChoice;
    const quality = transportQuality(record.transcriptionQuality);
    if (quality) metadata.transcriptionQuality = quality;
  }
  if (!translationOnly && qualityChoice === 'accurate' && subtitleChoice === 'ko' && metadata.hasAudio && !audioPath && !isCurrentFullTranscription(metadata, 'accurate')) {
    throw new Error('정확도 우선 한국어 자막에는 전체 음성 또는 최신 검수 방식으로 확인한 전체 인식 기록이 필요합니다.');
  }
  if (!translationOnly && qualityChoice === 'turbo' && metadata.hasAudio && !audioPath
    && (!isProcessedTranscription(metadata, 'turbo') || metadata.transcriptionQuality?.complete !== true)) {
    throw new Error('초고속 분석에는 전체 음성 또는 초고속 모드로 끝까지 인식한 대사 기록이 필요합니다.');
  }
  validateMetadata(metadata);
  const metadataLimit = supportsQuality ? MAX_METADATA : LEGACY_MAX_METADATA;
  let serialized = JSON.stringify(metadata), uploadDiagnosticsReduced = false;
  if (supportsQuality && Buffer.byteLength(serialized) > metadataLimit) {
    const reservedBytes = Buffer.byteLength(JSON.stringify({ ...metadata, transcript: [] })) - 2;
    const compacted = compactTranscriptDiagnostics(metadata.transcript, reservedBytes, metadataLimit);
    metadata.transcript = compacted.transcript;
    uploadDiagnosticsReduced = compacted.reduced;
    serialized = JSON.stringify(metadata);
  }
  if (Buffer.byteLength(serialized) > metadataLimit) throw new Error('대사 기록이 전송 크기 제한을 초과했습니다. 원문을 자르지 않고 전송을 중단했습니다.');
  const form = new FormData();
  form.append('metadata', serialized);
  let jobId = null;
  let receivedResult = null;
  try {
    for (const frame of metadata.frames) {
      const source = path.resolve(dataDir, 'frames', record.id, frame.filename);
      const info = await fsp.stat(source);
      if (!info.isFile() || info.size > MAX_IMAGE) throw new Error('대표 이미지 파일이 없거나 5MB를 초과했습니다.');
      form.append('frames', fs.createReadStream(source), { filename: frame.filename, contentType: 'image/jpeg', knownLength: info.size });
    }
    if (audioPath) {
      const info = await fsp.stat(audioPath);
      if (!info.isFile() || info.size > MAX_AUDIO) throw new Error('전송할 음성은 250MB 이하여야 합니다.');
      const lossless = path.extname(audioPath).toLowerCase() === '.flac';
      if (qualityChoice === 'accurate' && subtitleChoice === 'ko' && !lossless) throw new Error('정확도 우선 분석에는 무손실 FLAC 음성을 전송해 주세요.');
      if (qualityChoice === 'turbo' && !lossless) throw new Error('초고속 분석에는 무손실 FLAC 음성을 전송해 주세요.');
      if (lossless && !supportsQuality) throw new Error('FLAC 음성을 전송하려면 분석 서버 PC를 새 버전으로 업데이트해 주세요.');
      form.append('audio', fs.createReadStream(audioPath), { filename: lossless ? 'audio.flac' : 'audio.mp3', contentType: lossless ? 'audio/flac' : 'audio/mpeg', knownLength: info.size });
    }
    const length = await new Promise((resolve, reject) => form.getLength((error, size) => error ? reject(error) : resolve(size)));
    if (length > MAX_UPLOAD) throw new Error('전송할 분석 자료가 너무 큽니다.');
    onProgress(translationOnly ? '저장된 원문 대사를 번역 PC로 전송' : '음성과 대표 이미지를 분석 PC로 전송', 35);
    let job = await jsonRequest('/v1/jobs', { method: 'POST', body: form, timeout: 10 * 60 * 1000, headers: { ...auth, ...form.getHeaders(), 'Content-Length': String(length) } });
    if (typeof onDiagnostic === 'function' && SAFE_ID.test(job.id)) {
      try { Promise.resolve(onDiagnostic({ event: 'accepted', serverJobId: job.id })).catch(() => {}); } catch (_) {}
    }
    if (!SAFE_ID.test(job.id)) throw new Error('분석 서버가 올바르지 않은 작업 정보를 반환했습니다.');
    jobId = job.id;
    const recoverAcceptedGet = async (read, { frame = false } = {}) => {
      // Only repeat a read of this already accepted job. Uploads, provider
      // failures and HTTP refusals never enter this transport recovery path.
      for (let retry = 0; ; retry++) {
        try { return await read(); }
        catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw abortError();
          if (!TRANSIENT_NETWORK_ERRORS.has(error.code)
            || error.statusCode && (error.statusCode < 200 || error.statusCode >= 300)) throw error;
          if (retry >= reconnectDelays.length) {
            const message = frame
              ? `분석 서버의 이미지 연결을 ${reconnectDelays.length}회 다시 확인했지만 복구하지 못했습니다. 받은 분석 내용과 이미지는 보관했습니다.`
              : `분석 서버 연결을 ${reconnectDelays.length}회 다시 확인했지만 복구하지 못했습니다. 분석 서버 PC와 Wi-Fi 연결을 확인하세요. 서버에서는 기존 작업이 계속 실행 중일 수 있습니다.`;
            throw Object.assign(new Error(message), { code: frame ? 'LAN_FRAME_RECONNECT_FAILED' : 'LAN_STATUS_RECONNECT_FAILED' });
          }
          onProgress(frame ? '분석 서버 이미지 연결 복구 중' : '분석 서버 연결 복구 중', 40 + Math.max(0, Math.min(100, Number(job.percent) || 0)) * 0.55);
          await pause(reconnectDelays[retry], signal);
        }
      }
    };
    const pollAcceptedJob = () => recoverAcceptedGet(() => jsonRequest('/v1/jobs/' + jobId));
    while (!TERMINAL.has(job.status)) {
      onProgress(job.stage || '분석 PC에서 처리 중', 40 + Math.max(0, Math.min(100, Number(job.percent) || 0)) * 0.55,
        normalizeProgressDetails(job.phaseProgress));
      await pause(1000, signal);
      job = await pollAcceptedJob();
    }
    if (job.status !== 'completed' || !job.result) throw new Error(job.error || '분석 PC에서 처리를 완료하지 못했습니다.');
    if (job.result.subtitleTranslationProgress?.version === 2 && !host.capabilities?.includes('sparse-subtitles-v1')) {
      throw new Error('빠진 구간 뒤의 번역 자막을 받으려면 분석 서버 PC도 최신 버전으로 업데이트해 주세요.');
    }
    const result = translationOnly ? translationOnlyResult(record, job.result) : publicRecord(job.result, { ...record, frames: metadata.frames });
    if (uploadDiagnosticsReduced) result.warnings.push('전체 원문과 시간을 전송하기 위해 일부 단어별 진단 정보를 업로드에서 제외했습니다.');
    result.id = record.id;
    result.path = record.path;
    attachRemoteServerVersion(result, host.appVersion);
    if (translationOnly) {
      onProgress('completed', 100);
      return result;
    }
    receivedResult = result;
    const destination = path.resolve(dataDir, 'frames', record.id);
    await fsp.mkdir(destination, { recursive: true });
    const fingerprints = supportsFrameFingerprints ? frameFingerprints(job.frameFingerprints, metadata.frames) : null;
    for (const frame of result.frames) {
      if (signal?.aborted) throw abortError();
      if (fingerprints?.[frame.filename]
        && await localFrameFingerprint(path.join(destination, frame.filename), signal) === fingerprints[frame.filename]) continue;
      const readFrame = () => requestBuffer(target, `/v1/jobs/${jobId}/frames/${encodeURIComponent(frame.filename)}`, { headers: auth, signal, maxBytes: MAX_IMAGE });
      const buffer = await (supportsManagedUpdates ? recoverAcceptedGet(readFrame, { frame: true }) : readFrame());
      if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error('분석 서버의 이미지 응답이 올바르지 않습니다.');
      if (fingerprints?.[frame.filename] && crypto.createHash('sha256').update(buffer).digest('hex') !== fingerprints[frame.filename]) {
        throw Object.assign(new Error('분석 서버의 대표 이미지가 완료 기록과 일치하지 않습니다. 받은 분석 내용과 기존 이미지는 보관했습니다.'),
          { code: 'LAN_FRAME_FINGERPRINT_MISMATCH' });
      }
      await fsp.writeFile(path.join(destination, frame.filename), buffer);
    }
    onProgress('completed', 100);
    return result;
  } catch (error) {
    if (receivedResult) {
      // The text has already arrived. Preserve it even if the server is
      // disconnected during image retrieval, together with valid local JPEGs.
      const availableFrames = [];
      for (const frame of receivedResult.frames) {
        try {
          const bytes = await fsp.readFile(path.join(dataDir, 'frames', record.id, frame.filename));
          if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) availableFrames.push(frame);
        } catch (_) { /* Only list images that remain available on this PC. */ }
      }
      receivedResult.frames = availableFrames;
      receivedResult.status = 'partial';
      receivedResult.error = error.message;
      receivedResult.warnings = [...new Set([...(receivedResult.warnings || []), '서버 분석 내용은 받았지만 이미지 수신을 완료하지 못했습니다. 받은 줄거리·대사와 이 PC의 이미지는 보관했습니다.'])];
      error.record = receivedResult;
    }
    if (jobId && signal?.aborted) await requestBuffer(target, `/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: auth, timeout: 5000 }).catch(() => {});
    throw error;
  } finally {
    form.destroy();
  }
}

async function sendDiagnosticReports({ remoteUrl, connectionCode, reports, clientId, clientName, clientVersion, signal, capabilities, timeout = 5000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, Math.min(10000, Math.max(1, Number(timeout) || 5000)));
  timer.unref?.();
  try {
    if (!/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode || '')) throw new Error('인증 오류');
    const target = await resolveRemoteUrl(remoteUrl), headers = { Authorization: 'Bearer ' + connectionCode };
    const client = validateDiagnosticClient(Object.fromEntries(Object.entries({ clientId, clientName, clientVersion }).filter(([, value]) => value !== undefined)));
    let supported = capabilities;
    if (!Array.isArray(supported)) supported = JSON.parse((await requestBuffer(target, '/v1/status', { headers, signal: controller.signal, maxBytes: 16384, timeout: 5000 })).toString('utf8')).capabilities;
    if (!supported?.includes('diagnostics-v1')) return { ok: false, supported: false, acceptedReportIds: [] };
    if (!Array.isArray(reports) || !reports.length || reports.length > 50) throw new Error('Invalid reports');
    const selected = reports.map(item => {
      if (!item || !/^[a-f0-9]{64}$/.test(item.reportId)) throw new Error('Invalid report identity');
      return { reportId: item.reportId, event: sanitizeDiagnosticEvent(item.event) };
    });
    const body = Buffer.from(JSON.stringify({ ...client, reports: selected }));
    if (body.length > 64 * 1024) throw new Error('Diagnostic batch too large');
    const result = JSON.parse((await requestBuffer(target, '/v1/diagnostics/report', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body, signal: controller.signal, maxBytes: 16384, timeout: 5000 })).toString('utf8'));
    const sent = new Set(selected.map(item => item.reportId));
    if (!Array.isArray(result.acceptedReportIds) || result.acceptedReportIds.some(id => !sent.has(id))) throw new Error('Invalid diagnostic acknowledgment');
    return { ok: true, supported: true, acceptedReportIds: [...new Set(result.acceptedReportIds)] };
  } catch (error) { return { ok: false, acceptedReportIds: [], error: classifyDiagnosticError(error) }; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { createLanAnalysis, sendRemoteAnalysis, sendDiagnosticReports, checkRemoteServer, privateAddress, validateRemoteUrl, resolveRemoteUrl, validateMetadata };
