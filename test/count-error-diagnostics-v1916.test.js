const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyDiagnosticError } = require('../lib/diagnostics');

for (const stage of ['번역','검수']) test(`count-aware ${stage} errors retain their technical classification when only the message is available`, () => {
  const message=`한국어 자막 ${stage} 응답의 대사 개수가 올바르지 않습니다. 요청 80구간 · 응답 0구간. 검증된 기존 자막은 보관했습니다.`;
  const result=classifyDiagnosticError(message);
  assert.equal(result.code,'SUBTITLE_CUE_COUNT_MISMATCH');
  assert.equal(result.message,'번역 응답의 대사 개수가 원문 묶음과 일치하지 않습니다.');
  assert.equal(result.message.includes('80'),false,'canonical diagnostics do not preserve arbitrary raw error bodies');
});

test('older count errors keep the same diagnostic category',()=>{
  assert.equal(classifyDiagnosticError('한국어 자막 번역의 대사 수가 원문과 일치하지 않습니다.').code,'SUBTITLE_CUE_COUNT_MISMATCH');
});
