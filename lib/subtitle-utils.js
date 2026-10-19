const MAX_CUES = 50000;
const crypto = require('crypto');

function normalizeLanguageHint(value) {
  const language = value === undefined ? 'auto' : value;
  if (!['auto', 'ja', 'zh'].includes(language)) throw new Error('대사 언어는 자동 감지, 일본어 또는 중국어로 설정해 주세요.');
  return language;
}

function normalizeSubtitleLanguage(value) {
  const language = value === undefined ? 'original' : value;
  if (!['original', 'ko'].includes(language)) throw new Error('자막은 원문 또는 한국어로 설정해 주세요.');
  return language;
}

function detectedLanguage(value) {
  return typeof value === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(value) ? value : null;
}

function validCue(cue) {
  return cue && typeof cue.text === 'string' && cue.text.trim() && cue.text.length <= 10000
    && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start;
}

function validateTranslation(value, transcript) {
  if (!Array.isArray(transcript) || !transcript.length || transcript.length > MAX_CUES || transcript.some(cue => !validCue(cue))
    || !Array.isArray(value) || value.length !== transcript.length) throw new Error('한국어 자막의 대사 수가 원문과 일치하지 않습니다.');
  return value.map((cue, index) => {
    const original = transcript[index];
    if (!validCue(cue) || cue.start !== original.start || cue.end !== original.end) throw new Error('한국어 자막의 시간 정보가 원문과 일치하지 않습니다.');
    return { start: original.start, end: original.end, text: cue.text.trim() };
  });
}

function validatePartialTranslation(record) {
  const source = record?.transcript;
  const partial = record?.subtitleTranslationPartial;
  const progress = record?.subtitleTranslationProgress;
  if (!Array.isArray(source) || !source.length || source.length > MAX_CUES || source.some(cue => !validCue(cue))
    || !Array.isArray(partial) || !partial.length || partial.length > source.length
    || ![1, 2].includes(progress?.version) || progress.language !== 'ko' || progress.complete !== false
    || typeof progress.sourceComplete !== 'boolean' || typeof progress.sourceFingerprint !== 'string'
    || progress.sourceFingerprint.toLowerCase() !== crypto.createHash('sha256').update(JSON.stringify(source.map(cue => [cue.id ?? null, cue.start, cue.end, cue.text]))).digest('hex')
    || progress.totalCues !== source.length || progress.completedCues !== partial.length) {
    throw new Error('내보낼 수 있는 검수된 한국어 부분 자막이 없습니다.');
  }
  const sparse = progress.version === 2;
  const indexes = sparse ? progress.cueIndexes : partial.map((_, index) => index);
  if (sparse && (!Array.isArray(indexes) || indexes.length !== partial.length || indexes.length > MAX_CUES
    || indexes.some((index, offset) => !Number.isSafeInteger(index) || index < 0 || index >= source.length || offset > 0 && index <= indexes[offset - 1])
    || typeof progress.translationComplete !== 'boolean' || progress.translationComplete && partial.length !== source.length)) {
    throw new Error('한국어 부분 자막의 원문 번호나 완료 기록이 올바르지 않습니다.');
  }
  if (sparse && ['sourceProcessed', 'sourceAuditComplete'].some(key => progress[key] !== undefined && typeof progress[key] !== 'boolean')) {
    throw new Error('한국어 부분 자막의 원문 처리 기록이 올바르지 않습니다.');
  }
  for (let index = 0; index < partial.length; index++) {
    const original = source[indexes[index]];
    if (sparse ? partial[index]?.id !== original?.id : partial[index]?.id !== undefined && partial[index].id !== original?.id) {
      throw new Error('한국어 부분 자막의 대사 번호가 원문과 일치하지 않습니다.');
    }
  }
  return validateTranslation(partial, indexes.map(index => source[index]));
}

function subtitleTimestamp(seconds, separator) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const parts = [Math.floor(millis / 3600000), Math.floor(millis / 60000) % 60, Math.floor(millis / 1000) % 60];
  return parts.map(part => String(part).padStart(2, '0')).join(':') + separator + String(millis % 1000).padStart(3, '0');
}

function cueText(value) {
  // Blank cue separators and control characters must never become extra cues.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function subtitleText(record, { format = 'srt', language = 'original', partial = false } = {}) {
  if (!['srt', 'vtt'].includes(format)) throw new Error('자막 형식은 SRT 또는 VTT를 선택해 주세요.');
  normalizeSubtitleLanguage(language);
  const transcript = record?.transcript;
  if (!Array.isArray(transcript) || !transcript.length || transcript.length > MAX_CUES || transcript.some(cue => !validCue(cue))) {
    throw new Error('내보낼 수 있는 시간별 대사가 없습니다. 음성 인식 또는 자막 추출을 먼저 완료해 주세요.');
  }
  if (partial && language !== 'ko') throw new Error('부분 자막 저장은 한국어 번역을 선택해 주세요.');
  const cues = language === 'ko' ? (partial ? validatePartialTranslation(record) : validateTranslation(record.subtitleTranslation, transcript)) : transcript;
  if (language === 'ko' && !partial && (record.subtitleLanguage !== 'ko' || record.subtitleTranslationProgress?.complete === false)) throw new Error('한국어 자막이 아직 완료되지 않았습니다.');
  const separator = format === 'srt' ? ',' : '.';
  const body = cues.map((cue, index) => {
    const start = subtitleTimestamp(cue.start, separator);
    // Very short valid intervals still require a positive duration after rounding.
    const end = subtitleTimestamp(Math.max(cue.end, Math.round(cue.start * 1000) / 1000 + 0.001), separator);
    return `${index + 1}\n${start} --> ${end}\n${cueText(cue.text)}`;
  }).join('\n\n');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + body + '\n';
}

module.exports = { normalizeLanguageHint, normalizeSubtitleLanguage, detectedLanguage, validateTranslation, validatePartialTranslation, subtitleTimestamp, subtitleText };
