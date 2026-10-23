const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitTranslationRefusal } = require('../lib/subtitle-refusal');

const explicitRefusals = [
    '이 요청의 번역을 제공할 수 없습니다.',
    '정책상 이 자료의 번역은 불가합니다.',
    '정책으로 인해 요청하신 텍스트를 번역해 드릴 수 없습니다.',
    '이러한 콘텐츠의 번역을 도와드릴 수 없습니다.',
    '해당 내용은 번역할 수 없습니다.',
    '이 내용은 번역을 할 수 없습니다.',
    '요청하신 대사는 번역할 수 없습니다.',
    'I cannot provide a translation of this content.',
    '죄송하지만 해당 요청을 도와드릴 수 없습니다.',
    '이 요청을 도와드릴 수 없습니다.',
    '요청하신 작업을 수행할 수 없습니다.',
    'We are unable to generate the requested subtitles.',
    'I can’t assist with translating this text.',
    '제공된 자료의 번역을 진행할 수 없습니다.'
];

for (const [index, text] of explicitRefusals.entries()) {
    test(`known explicit task refusal remains detected ${index + 1}`, () => {
        assert.equal(explicitTranslationRefusal(text), true);
    });
}

const ordinaryDialogue = [
    '우리 아이 번역할 수 없어. 영어를 아직 배우지 않았거든.',
    '그 둘이 번역할 수 없어. 새 통역사를 불러 줘.',
    '수진이 번역할 수 없어. 오늘은 사무실에 없거든.',
    '한 사람이 요청을 처리할 수 없어. 동료를 불러 줘.',
    '책상이 작업을 수행할 수 없어. 사람이 해야지.',
    '내가 지금 바빠서 도와줄 수 없어. 오늘 저녁에는 다시 이야기하자.',
    '도와줄 수 없다.',
    '오늘은 번역할 수 없어. 내일 다시 읽자.'
];

for (const [index, text] of ordinaryDialogue.entries()) {
    test(`ordinary neutral dialogue does not treat a Korean subject suffix as a task prefix ${index + 1}`, () => {
        assert.equal(explicitTranslationRefusal(text), false);
    });
}

for (const prefix of ['1', '１２３', 'A', 'é', '_', 'ID_', '가', 'あ', '字']) {
    test(`scoped task references cannot start inside a letter, number or identifier token ${JSON.stringify(prefix)}`, () => {
        assert.equal(explicitTranslationRefusal(`${prefix}이 요청을 처리할 수 없습니다.`), false);
        assert.equal(explicitTranslationRefusal(`${prefix}이 번역할 수 없습니다.`), false);
        assert.equal(explicitTranslationRefusal(`${prefix}해당 요청을 도와드릴 수 없습니다.`), false);
        assert.equal(explicitTranslationRefusal(`${prefix}요청하신 대사는 번역할 수 없습니다.`), false);
    });
}

for (const prefix of ['', ' ', '\n', '안내: ', '1:', '(', '“', '—', '🙂']) {
    test(`explicit scoped refusals remain detected after punctuation or whitespace ${JSON.stringify(prefix)}`, () => {
        assert.equal(explicitTranslationRefusal(`${prefix}이 요청을 처리할 수 없습니다.`), true);
        assert.equal(explicitTranslationRefusal(`${prefix}해당 내용은 번역할 수 없습니다.`), true);
    });
}

test('normalization preserves explicit refusal detection across compatible characters and line breaks', () => {
    assert.equal(explicitTranslationRefusal('이\n요청을\t도와드릴 수 없습니다.'), true);
    assert.equal(explicitTranslationRefusal('Ｉ ｃａｎｎｏｔ ｐｒｏｖｉｄｅ ａ ｔｒａｎｓｌａｔｉｏｎ.'), true);
});

test('quoted explicit task refusals remain detected rather than receiving an unsupported semantic exemption', () => {
    assert.equal(explicitTranslationRefusal('화면에 “이 요청을 처리할 수 없습니다.”라는 메시지가 나왔어.'), true);
    assert.equal(explicitTranslationRefusal('“I cannot provide a translation.”라는 문장이 적혀 있어.'), true);
});
