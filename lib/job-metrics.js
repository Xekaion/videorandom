const LABELS = { prepare: '분석 준비', probe: '영상 정보', frames: '대표 장면', subtitles: '원문 자막', transcription: '음성 인식',
  summary: '줄거리와 라벨', translation: '한국어 번역', translation_review: '한국어 번역 검수', audit: '발화 누락 검사', recovery: '발화 재확인',
  upload: '분석 서버 전송', audio: '음성 준비', saving: '결과 저장', completed: '완료', processing: '영상 분석' };

function stageIdentity(value) {
  const stage = String(value || '');
  if (Object.hasOwn(LABELS, stage)) return { stageKey: stage, label: LABELS[stage] };
  const key = stage.startsWith('한국어 자막 번역') ? 'translation' : stage.startsWith('한국어 자막 검수') ? 'translation_review'
    : stage === '대사 누락 재확인' ? 'recovery' : stage === '전체 음성 범위 확인' ? 'audit'
      : stage === '서버에 보낼 음성 준비' ? 'audio' : /^(?:음성과 대표 이미지를 분석 PC로 전송|분석 PC에서 처리 중)$/.test(stage) ? 'upload' : 'processing';
  return { stageKey: key, label: LABELS[key] };
}

function createMetrics(clock = Date.now) {
  const startedAt = clock();
  let active = { ...stageIdentity('prepare'), startedAt }, finished = null;
  const stages = [];
  function stage(value) {
    if (finished) return;
    const next = stageIdentity(value);
    if (next.stageKey === active.stageKey) return;
    const end = clock();
    stages.push({ stageKey: active.stageKey, label: active.label, durationMs: Math.max(0, end - active.startedAt) });
    active = { ...next, startedAt: end };
  }
  function finish() {
    if (!finished) {
      const end = clock();
      finished = { totalMs: Math.max(0, end - startedAt), stages: [...stages,
        { stageKey: active.stageKey, label: active.label, durationMs: Math.max(0, end - active.startedAt) }] };
    }
    return { totalMs: finished.totalMs, stages: finished.stages.map(item => ({ ...item })) };
  }
  return { stage, finish };
}

module.exports = { stageIdentity, createMetrics };
